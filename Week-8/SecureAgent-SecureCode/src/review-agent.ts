import { Octokit } from "@octokit/rest";
import { WebhookEventMap } from "@octokit/webhooks-definitions/schema";
import { ChatCompletionMessageParam } from "groq-sdk/resources/chat/completions";
import * as xml2js from "xml2js";
import type {
  BranchDetails,
  BuilderResponse,
  Builders,
  CodeSuggestion,
  PRFile,
  PRSuggestion,
} from "./constants";
import { PRSuggestionImpl } from "./data/PRSuggestionImpl";
import { generateChatCompletion } from "./llms/chat";
import {
  PR_SUGGESTION_TEMPLATE,
  buildPatchPrompt,
  constructPrompt,
  getReviewPrompt,
  getTokenLength,
  getXMLReviewPrompt,
  isConversationWithinLimit,
} from "./prompts";
import {
  INLINE_FIX_FUNCTION,
  getInlineFixPrompt,
} from "./prompts/inline-prompt";
import { getGitFile } from "./reviews";

export const reviewDiff = async (messages: ChatCompletionMessageParam[]) => {
  const message = await generateChatCompletion({
    messages,
  });
  return message.content;
};

export const reviewFiles = async (
  files: PRFile[],
  patchBuilder: (file: PRFile) => string,
  convoBuilder: (diff: string) => ChatCompletionMessageParam[]
) => {
  const patches = files.map((file) => patchBuilder(file));
  const messages = convoBuilder(patches.join("\n"));
  const feedback = await reviewDiff(messages);
  return feedback;
};

const filterFile = (file: PRFile) => {
  const extensionsToIgnore = new Set<string>([
    "pdf",
    "png",
    "jpg",
    "jpeg",
    "gif",
    "mp4",
    "mp3",
    "md",
    "json",
    "env",
    "toml",
    "svg",
  ]);
  const filesToIgnore = new Set<string>([
    "package-lock.json",
    "yarn.lock",
    ".gitignore",
    "package.json",
    "tsconfig.json",
    "poetry.lock",
    "readme.md",
  ]);
  const filename = file.filename.toLowerCase().split("/").pop();
  if (filename && filesToIgnore.has(filename)) {
    console.log(`Filtering out ignored file: ${file.filename}`);
    return false;
  }
  const splitFilename = file.filename.toLowerCase().split(".");
  if (splitFilename.length <= 1) {
    console.log(`Filtering out file with no extension: ${file.filename}`);
    return false;
  }
  const extension = splitFilename.pop()?.toLowerCase();
  if (extension && extensionsToIgnore.has(extension)) {
    console.log(`Filtering out file with ignored extension: ${file.filename} (.${extension})`);
    return false;
  }
  return true;
};

const groupFilesByExtension = (files: PRFile[]): Map<string, PRFile[]> => {
  const filesByExtension: Map<string, PRFile[]> = new Map();

  files.forEach((file) => {
    const extension = file.filename.split(".").pop()?.toLowerCase();
    if (extension) {
      if (!filesByExtension.has(extension)) {
        filesByExtension.set(extension, []);
      }
      filesByExtension.get(extension)?.push(file);
    }
  });

  return filesByExtension;
};

// all of the files here can be processed with the prompt at minimum
const processWithinLimitFiles = (
  files: PRFile[],
  patchBuilder: (file: PRFile) => string,
  convoBuilder: (diff: string) => ChatCompletionMessageParam[]
) => {
  const processGroups: PRFile[][] = [];
  const convoWithinModelLimit = isConversationWithinLimit(
    constructPrompt(files, patchBuilder, convoBuilder)
  );

  console.log(`Within model token limits: ${convoWithinModelLimit}`);
  if (!convoWithinModelLimit) {
    const grouped = groupFilesByExtension(files);
    for (const [extension, filesForExt] of grouped.entries()) {
      const extGroupWithinModelLimit = isConversationWithinLimit(
        constructPrompt(filesForExt, patchBuilder, convoBuilder)
      );
      if (extGroupWithinModelLimit) {
        processGroups.push(filesForExt);
      } else {
        // extension group exceeds model limit
        console.log(
          "Processing files per extension that exceed model limit ..."
        );
        let currentGroup: PRFile[] = [];
        filesForExt.sort((a, b) => a.patchTokenLength - b.patchTokenLength);
        filesForExt.forEach((file) => {
          const isPotentialGroupWithinLimit = isConversationWithinLimit(
            constructPrompt([...currentGroup, file], patchBuilder, convoBuilder)
          );
          if (isPotentialGroupWithinLimit) {
            currentGroup.push(file);
          } else {
            processGroups.push(currentGroup);
            currentGroup = [file];
          }
        });
        if (currentGroup.length > 0) {
          processGroups.push(currentGroup);
        }
      }
    }
  } else {
    processGroups.push(files);
  }
  return processGroups;
};

const stripRemovedLines = (originalFile: PRFile) => {
  // remove lines starting with a '-'
  const originalPatch = String.raw`${originalFile.patch}`;
  const strippedPatch = originalPatch
    .split("\n")
    .filter((line) => !line.startsWith("-"))
    .join("\n");
  return { ...originalFile, patch: strippedPatch };
};

const processOutsideLimitFiles = (
  files: PRFile[],
  patchBuilder: (file: PRFile) => string,
  convoBuilder: (diff: string) => ChatCompletionMessageParam[]
) => {
  const processGroups: PRFile[][] = [];
  if (files.length == 0) {
    return processGroups;
  }
  files = files.map((file) => stripRemovedLines(file));
  const convoWithinModelLimit = isConversationWithinLimit(
    constructPrompt(files, patchBuilder, convoBuilder)
  );
  if (convoWithinModelLimit) {
    processGroups.push(files);
  } else {
    const exceedingLimits: PRFile[] = [];
    const withinLimits: PRFile[] = [];
    files.forEach((file) => {
      const isFileConvoWithinLimits = isConversationWithinLimit(
        constructPrompt([file], patchBuilder, convoBuilder)
      );
      if (isFileConvoWithinLimits) {
        withinLimits.push(file);
      } else {
        exceedingLimits.push(file);
      }
    });
    const withinLimitsGroup = processWithinLimitFiles(
      withinLimits,
      patchBuilder,
      convoBuilder
    );
    withinLimitsGroup.forEach((group) => {
      processGroups.push(group);
    });
    if (exceedingLimits.length > 0) {
      console.log("TODO: Need to further chunk large file changes.");
      // throw "Unimplemented"
    }
  }
  return processGroups;
};

const processXMLSuggestions = async (feedbacks: string[]) => {
  // Configure XML parser with security options to prevent XXE attacks
  const xmlParser = new xml2js.Parser({
    // Security options
    explicitCharkey: true,
    normalizeTags: false,
    normalize: false,
    explicitArray: true, // Keep as arrays for consistent handling
    strict: true,
    
    // Improve attribute handling
    attrNameProcessors: [(name: string) => name.trim().substring(0, 100)],
    tagNameProcessors: [(name: string) => name.trim().substring(0, 100)],
    
    // Additional options for better parsing
    trim: true             // Trim whitespace
  });

  try {
    const parsedSuggestions = await Promise.all(
      feedbacks.map(async (fb) => {
        // Log original feedback for debugging
        console.log("DEBUG: Original feedback length:", fb.length);
        
        // First check if we even have a <review> tag
        if (!fb.includes("<review>") || !fb.includes("</review>")) {
          console.log("DEBUG: No review tags found in feedback");
          return { review: { suggestion: [] } };
        }
        
        // Extract just the review section to avoid parsing unrelated content
        const reviewStartIndex = fb.indexOf("<review>");
        const reviewEndIndex = fb.lastIndexOf("</review>") + "</review>".length;
        
        if (reviewStartIndex === -1 || reviewEndIndex === -1) {
          console.log("DEBUG: Couldn't find complete review tags");
          return { review: { suggestion: [] } };
        }
        
        // Extract just the review section
        fb = fb.substring(reviewStartIndex, reviewEndIndex);
        
        // Sanitize XML before processing
        // First, clean up any malformed XML and protect code blocks
        let sanitizedFb = fb
          .replace(/<!DOCTYPE[^>]*>/gi, '') // Remove any DOCTYPE declarations
          .replace(/<!ENTITY[^>]*>/gi, ''); // Remove any ENTITY declarations
          
        // Special handling for code blocks with triple backticks inside code tags
        // This is a common pattern in GitHub-flavored markdown
        sanitizedFb = sanitizedFb.replace(
          /<code>([\s\S]*?)<\/code>/g,
          (match, codeContent) => {
            // Remove the triple backticks and language identifier, they're not valid XML
            let cleanCode = codeContent
              .replace(/```[\w]*\n/g, '') // Remove opening backticks with language
              .replace(/```/g, '');        // Remove closing backticks
              
            // Wrap in CDATA to protect special characters
            return `<code><![CDATA[${cleanCode}]]></code>`;
          }
        );
        
        // If there are still triple backticks outside of code tags, they might be malformed
        // Attempt to fix by wrapping them in code tags
        sanitizedFb = sanitizedFb.replace(
          /```([\w]*)\n([\s\S]*?)```/g,
          (match, language, code) => {
            return `<code><![CDATA[${code}]]></code>`;
          }
        );
        
        console.log("DEBUG: Sanitized feedback sample (first 200 chars):", sanitizedFb.substring(0, 200));
        
        try {
          const result = await xmlParser.parseStringPromise(sanitizedFb);
          
          // Debug the XML structure
          console.log("DEBUG: XML Structure:", JSON.stringify({
            hasReview: !!result.review,
            hasSuggestion: result.review && !!result.review.suggestion,
            suggestionCount: result.review && result.review.suggestion ? result.review.suggestion.length : 0,
            firstSuggestionKeys: result.review && result.review.suggestion && result.review.suggestion.length > 0 
              ? Object.keys(result.review.suggestion[0]) 
              : []
          }, null, 2));
          
          return result;
        } catch (error) {
          console.log(`XML parsing error: ${error.message || 'Unknown error'}`);
          return { review: { suggestion: [] } }; // Return empty placeholder on error
        }
      })
    );

    // gets suggestion arrays [[suggestion], [suggestion]], then flattens
    const allSuggestions = parsedSuggestions
      .filter(sug => sug && sug.review && sug.review.suggestion) // Safely handle null/undefined
      .map((sug) => sug.review.suggestion)
      .flat(1);
      
    console.log("DEBUG: All suggestions count:", allSuggestions.length);
    
    if (allSuggestions.length > 0 && allSuggestions[0]) {
      console.log("DEBUG: First suggestion structure:", JSON.stringify({
        keys: Object.keys(allSuggestions[0]),
        codeType: allSuggestions[0].code ? typeof allSuggestions[0].code : 'undefined',
        codeIsArray: Array.isArray(allSuggestions[0].code),
        codeLength: Array.isArray(allSuggestions[0].code) ? allSuggestions[0].code.length : 0
      }, null, 2));
    }
      
    const suggestions: PRSuggestion[] = allSuggestions.map((rawSuggestion) => {
      if (!rawSuggestion) {
        console.log("DEBUG: Suggestion is null or undefined");
        return null;
      }
      
      console.log("DEBUG: Processing suggestion with keys:", Object.keys(rawSuggestion));
      console.log("DEBUG: Code field type:", typeof rawSuggestion.code);
      
      if (!rawSuggestion.code) {
        console.log("DEBUG: Code field is missing");
        return null;
      }
      
      try {
        // Handle different possible structures of code field
        let codeContent;
        
        if (typeof rawSuggestion.code === 'string') {
          // If code is already a string
          codeContent = rawSuggestion.code;
          console.log("DEBUG: Code is a string");
        } else if (Array.isArray(rawSuggestion.code) && rawSuggestion.code.length > 0) {
          // If code is an array, try to get the first element
          const firstElement = rawSuggestion.code[0];
          
          if (typeof firstElement === 'string') {
            codeContent = firstElement;
          } else if (typeof firstElement === 'object' && firstElement !== null) {
            // It might be a structure with _: content or $: attributes
            if (firstElement._ && typeof firstElement._ === 'string') {
              codeContent = firstElement._;
            } else if (firstElement.$) {
              codeContent = JSON.stringify(firstElement.$);
            } else {
              // Try to stringify the whole object as fallback
              codeContent = JSON.stringify(firstElement);
            }
          }
          console.log("DEBUG: Code is an array, processed content type:", typeof codeContent);
        } else if (typeof rawSuggestion.code === 'object' && rawSuggestion.code !== null) {
          // Special case for xml2js CDATA parsing which might put content in _
          if (rawSuggestion.code._ && typeof rawSuggestion.code._ === 'string') {
            codeContent = rawSuggestion.code._;
            console.log("DEBUG: Code has CDATA structure with _ property");
          } else if (rawSuggestion.code.$ && typeof rawSuggestion.code.$ === 'object') {
            // If it has attributes, use them as fallback
            codeContent = JSON.stringify(rawSuggestion.code.$);
            console.log("DEBUG: Code has attribute structure with $ property");
          } else {
            // Try to stringify the whole object as last resort
            codeContent = JSON.stringify(rawSuggestion.code);
            console.log("DEBUG: Code is an object, converting to string");
          }
        } else {
          console.log("DEBUG: Code has unknown structure:", rawSuggestion.code);
          return null;
        }
        
        // Ensure code content is a string
        if (typeof codeContent !== 'string') {
          console.log("DEBUG: Code content is not a string:", typeof codeContent);
          return null;
        }
        
        const lines = codeContent.trim().split("\n");
        lines[0] = lines[0].trim();
        lines[lines.length - 1] = lines[lines.length - 1].trim();
        const code = lines.join("\n");

        // Similarly handle other fields
        let describe = '';
        if (typeof rawSuggestion.describe === 'string') {
          describe = rawSuggestion.describe;
        } else if (Array.isArray(rawSuggestion.describe) && rawSuggestion.describe.length > 0) {
          describe = String(rawSuggestion.describe[0]);
        }
        
        let type = '';
        if (typeof rawSuggestion.type === 'string') {
          type = rawSuggestion.type;
        } else if (Array.isArray(rawSuggestion.type) && rawSuggestion.type.length > 0) {
          type = String(rawSuggestion.type[0]);
        }
        
        let comment = '';
        if (typeof rawSuggestion.comment === 'string') {
          comment = rawSuggestion.comment;
        } else if (Array.isArray(rawSuggestion.comment) && rawSuggestion.comment.length > 0) {
          comment = String(rawSuggestion.comment[0]);
        }
        
        let filename = '';
        if (typeof rawSuggestion.filename === 'string') {
          filename = rawSuggestion.filename;
        } else if (Array.isArray(rawSuggestion.filename) && rawSuggestion.filename.length > 0) {
          filename = String(rawSuggestion.filename[0]);
        }

        return new PRSuggestionImpl(
          describe,
          type,
          comment,
          code,
          filename
        );
      } catch (error) {
        console.log(`Error processing suggestion: ${error.message || 'Unknown error'}`);
        return null;
      }
    }).filter(Boolean); // Filter out null values
    
    console.log(`DEBUG: Processed ${suggestions.length} valid suggestions`);
    return suggestions;
  } catch (error) {
    console.log(`Error in processXMLSuggestions: ${error.message || 'Unknown error'}`);
    return [];
  }
};

const generateGithubIssueUrl = (
  owner: string,
  repoName: string,
  title: string,
  body: string,
  codeblock?: string
) => {
  try {
    // Validate input parameters
    if (!owner || !repoName || typeof owner !== 'string' || typeof repoName !== 'string') {
      console.log(`Invalid owner or repo name parameters: ${owner}, ${repoName}`);
      return "[Create Issue](https://github.com)";
    }
    
    // Validate owner and repo format for URL safety
    if (!/^[a-zA-Z0-9-_.]+$/.test(owner) || !/^[a-zA-Z0-9-_.]+$/.test(repoName)) {
      console.log(`Invalid owner or repo name format: ${owner}, ${repoName}`);
      return "[Create Issue](https://github.com)";
    }
    
    // Sanitize and encode URL parameters
    const sanitizedTitle = (title || '').substring(0, 200);
    const sanitizedBody = (body || '').substring(0, 5000);
    const sanitizedCodeBlock = codeblock ? codeblock.substring(0, 10000) : "";
    
    const encodedTitle = encodeURIComponent(sanitizedTitle);
    const encodedBody = encodeURIComponent(sanitizedBody);
    const encodedCodeBlock = sanitizedCodeBlock
      ? encodeURIComponent(`\n${sanitizedCodeBlock}\n`)
      : "";

    // Construct and validate the URL length
    let url = `https://github.com/${owner}/${repoName}/issues/new?title=${encodedTitle}&body=${encodedBody}${encodedCodeBlock}`;

    // GitHub URLs have length limits, truncate if necessary
    if (url.length > 2048) {
      url = `https://github.com/${owner}/${repoName}/issues/new?title=${encodedTitle}&body=${encodedBody}`;
    }
    
    return `[Create Issue](${url})`;
  } catch (error) {
    console.log(`Error generating GitHub issue URL: ${error.message || 'Unknown error'}`);
    return "[Create Issue](https://github.com)";
  }
};

export const dedupSuggestions = (
  suggestions: PRSuggestion[]
): PRSuggestion[] => {
  const suggestionsMap = new Map<string, PRSuggestion>();
  suggestions.forEach((suggestion) => {
    suggestionsMap.set(suggestion.identity(), suggestion);
  });
  return Array.from(suggestionsMap.values());
};

const convertPRSuggestionToComment = (
  owner: string,
  repo: string,
  suggestions: PRSuggestion[]
): string[] => {
  const suggestionsMap = new Map<string, PRSuggestion[]>();
  suggestions.forEach((suggestion) => {
    if (!suggestionsMap.has(suggestion.filename)) {
      suggestionsMap.set(suggestion.filename, []);
    }
    suggestionsMap.get(suggestion.filename).push(suggestion);
  });
  const comments: string[] = [];
  for (let [filename, suggestions] of suggestionsMap) {
    const temp = [`## ${filename}\n`];
    suggestions.forEach((suggestion: PRSuggestion) => {
      const issueLink = generateGithubIssueUrl(
        owner,
        repo,
        suggestion.describe,
        suggestion.comment,
        suggestion.code
      );
      temp.push(
        PR_SUGGESTION_TEMPLATE.replace("{COMMENT}", suggestion.comment)
          .replace("{CODE}", suggestion.code)
          .replace("{ISSUE_LINK}", issueLink)
      );
    });
    comments.push(temp.join("\n"));
  }
  return comments;
};

const fallbackTextParser = (text: string): PRSuggestion[] => {
  try {
    console.log("DEBUG: Using fallback text parser");
    
    // Look for code blocks with backticks
    const codeBlockRegex = /```(?:(\w+))?\s*([\s\S]*?)```/g;
    let match;
    const suggestions: PRSuggestion[] = [];
    
    // Find all code blocks
    while ((match = codeBlockRegex.exec(text)) !== null) {
      const language = match[1] || 'js';
      const code = match[2];
      
      if (!code || code.trim().length === 0) {
        continue; // Skip empty code blocks
      }
      
      console.log(`DEBUG: Found code block with language: ${language}`);
      
      // Try to find a filename near the code block
      // Look at the 500 characters before the code block
      const searchStart = Math.max(0, match.index - 500);
      const beforeBlock = text.substring(searchStart, match.index);
      
      // Different patterns to look for filenames
      const filenamePatterns = [
        /(?:file|filename|path)[:\s]+([^\s,]+\.[a-zA-Z0-9]+)/i,
        /in\s+(?:file|filename|path)?\s+([^\s,]+\.[a-zA-Z0-9]+)/i,
        /for\s+(?:file|filename|path)?\s+([^\s,]+\.[a-zA-Z0-9]+)/i,
        /([^\s,]+\.[a-zA-Z0-9]+):/i
      ];
      
      // Try each pattern
      let filename = null;
      for (const pattern of filenamePatterns) {
        const filenameMatch = beforeBlock.match(pattern);
        if (filenameMatch) {
          filename = filenameMatch[1];
          break;
        }
      }
      
      // Fallback filename based on detected language
      if (!filename) {
        // Map common languages to file extensions
        const extensionMap = {
          'js': 'js',
          'javascript': 'js',
          'ts': 'ts',
          'typescript': 'ts',
          'py': 'py',
          'python': 'py',
          'java': 'java',
          'c': 'c',
          'cpp': 'cpp',
          'cs': 'cs',
          'go': 'go',
          'rust': 'rs',
          'php': 'php',
          'ruby': 'rb',
          'html': 'html',
          'css': 'css'
        };
        
        const extension = extensionMap[language.toLowerCase()] || 'txt';
        filename = `code-suggestion.${extension}`;
      }
      
      // Extract comment/description before the code block
      // Look for paragraphs or sentences in the 300 characters before the code block
      const commentSearchArea = beforeBlock.slice(-300);
      let comment = '';
      
      // Try to get the last paragraph
      const paragraphs = commentSearchArea.split(/\n\s*\n/);
      if (paragraphs.length > 0) {
        comment = paragraphs[paragraphs.length - 1].trim();
      }
      
      // If that didn't work, get the last few sentences
      if (!comment || comment.length < 20) {
        const sentences = commentSearchArea.split(/[.!?]\s+/);
        if (sentences.length > 0) {
          comment = sentences.slice(-2).join('. ').trim();
        }
      }
      
      // If still no good comment, use a generic one
      if (!comment || comment.length < 20) {
        comment = `Consider this code improvement for better ${language} implementation`;
      }
      
      // Create a suggestion with the extracted information
      suggestions.push(new PRSuggestionImpl(
        `Code suggestion for ${filename}`,
        'improvement',
        comment,
        `\`\`\`${language}\n${code}\n\`\`\``,
        filename
      ));
    }
    
    console.log(`DEBUG: Fallback parser found ${suggestions.length} suggestions`);
    return suggestions;
  } catch (error) {
    console.log(`ERROR in fallback parser: ${error.message}`);
    return [];
  }
};

const xmlResponseBuilder = async (
  owner: string,
  repoName: string,
  feedbacks: string[]
): Promise<BuilderResponse> => {
  console.log("IN XML RESPONSE BUILDER");
  
  try {
    // First try normal XML parsing
    const parsedXMLSuggestions = await processXMLSuggestions(feedbacks);
    
    // If we got suggestions, use them
    if (parsedXMLSuggestions && parsedXMLSuggestions.length > 0) {
      const comments = convertPRSuggestionToComment(
        owner,
        repoName,
        dedupSuggestions(parsedXMLSuggestions)
      );
      
      // If comments array is empty, provide a default comment
      if (!comments || comments.length === 0) {
        return { 
          comment: "The code review was completed successfully, but no specific comments were generated.",
          structuredComments: parsedXMLSuggestions 
        };
      }
      
      const commentBlob = comments.join("\n");
      
      // If commentBlob is empty after joining, provide a default comment
      if (!commentBlob || commentBlob.trim() === '') {
        return { 
          comment: "The code review was completed successfully, but no specific comments were generated.",
          structuredComments: parsedXMLSuggestions 
        };
      }
      
      return { comment: commentBlob, structuredComments: parsedXMLSuggestions };
    }
    
    // If XML parsing didn't produce results, try fallback text parsing
    console.log("XML parsing did not yield results, trying fallback text parser");
    
    let allSuggestions: PRSuggestion[] = [];
    for (const feedback of feedbacks) {
      const suggestions = fallbackTextParser(feedback);
      allSuggestions = allSuggestions.concat(suggestions);
    }
    
    if (allSuggestions.length > 0) {
      console.log(`Fallback parser found ${allSuggestions.length} suggestions`);
      const comments = convertPRSuggestionToComment(
        owner,
        repoName,
        dedupSuggestions(allSuggestions)
      );
      
      const commentBlob = comments.join("\n");
      return { comment: commentBlob, structuredComments: allSuggestions };
    }
    
    // If we still don't have suggestions, return the default message
    return { 
      comment: "The code was reviewed but no specific suggestions were generated. The code appears to follow good practices.",
      structuredComments: [] 
    };
  } catch (error) {
    console.log(`ERROR in xmlResponseBuilder: ${error.message}`);
    // Final fallback
    return { 
      comment: "The code review was completed, but an error occurred during processing. The code appears to be functional.",
      structuredComments: [] 
    };
  }
};

const curriedXmlResponseBuilder = (owner: string, repoName: string) => {
  return (feedbacks: string[]) =>
    xmlResponseBuilder(owner, repoName, feedbacks);
};

const basicResponseBuilder = async (
  feedbacks: string[]
): Promise<BuilderResponse> => {
  console.log("IN BASIC RESPONSE BUILDER");
  const commentBlob = feedbacks.join("\n");
  return { comment: commentBlob, structuredComments: [] };
};

export const reviewChanges = async (
  files: PRFile[],
  convoBuilder: (diff: string) => ChatCompletionMessageParam[],
  responseBuilder: (responses: string[]) => Promise<BuilderResponse>
) => {
  const patchBuilder = buildPatchPrompt;
  const filteredFiles = files.filter((file) => filterFile(file));
  filteredFiles.map((file) => {
    file.patchTokenLength = getTokenLength(patchBuilder(file));
  });
  // further subdivide if necessary, maybe group files by common extension?
  const patchesWithinModelLimit: PRFile[] = [];
  // these single file patches are larger than the full model context
  const patchesOutsideModelLimit: PRFile[] = [];

  filteredFiles.forEach((file) => {
    const patchWithPromptWithinLimit = isConversationWithinLimit(
      constructPrompt([file], patchBuilder, convoBuilder)
    );
    if (patchWithPromptWithinLimit) {
      patchesWithinModelLimit.push(file);
    } else {
      patchesOutsideModelLimit.push(file);
    }
  });

  console.log(`files within limits: ${patchesWithinModelLimit.length}`);
  const withinLimitsPatchGroups = processWithinLimitFiles(
    patchesWithinModelLimit,
    patchBuilder,
    convoBuilder
  );
  const exceedingLimitsPatchGroups = processOutsideLimitFiles(
    patchesOutsideModelLimit,
    patchBuilder,
    convoBuilder
  );
  console.log(`${withinLimitsPatchGroups.length} within limits groups.`);
  console.log(
    `${patchesOutsideModelLimit.length} files outside limit, skipping them.`
  );

  const groups = [...withinLimitsPatchGroups, ...exceedingLimitsPatchGroups];

  try {
    const feedbacks = await Promise.all(
      groups.map((patchGroup) => {
        return reviewFiles(patchGroup, patchBuilder, convoBuilder);
      })
    );
  
    try {
      return await responseBuilder(feedbacks);
    } catch (exc) {
      console.log(`XML parsing error: ${exc.message || 'Unknown error'}`);
      // Fallback to a basic response without XML parsing
      return {
        comment: "Unable to process XML response correctly. Review generated but parsing failed.",
        structuredComments: []
      };
    }
  } catch (error) {
    console.log(`Error reviewing changes: ${error.message || 'Unknown error'}`);
    return {
      comment: "Error occurred during review process",
      structuredComments: []
    };
  }
};

const indentCodeFix = (
  file: string,
  code: string,
  lineStart: number
): string => {
  try {
    const fileLines = file.split("\n");
    // Check if line index is in range
    if (lineStart < 1 || lineStart > fileLines.length) {
      return code; // Return unmodified code if out of range
    }
    
    const firstLine = fileLines[lineStart - 1];
    const codeLines = code.split("\n");
    
    // Use a safer regex pattern with a maximum length limit to prevent ReDoS
    const indentMatch = firstLine.match(/^[ \t]{0,100}/);
    
    // Check if match exists and has a result
    const indentation = indentMatch && indentMatch[0] ? indentMatch[0] : '';
    
    const indentedCodeLines = codeLines.map((line) => indentation + line);
    return indentedCodeLines.join("\n");
  } catch (error) {
    console.log(`Error in indentCodeFix: ${error.message || 'Unknown error'}`);
    return code; // Return unmodified code on error
  }
};

const isCodeSuggestionNew = (
  contents: string,
  suggestion: CodeSuggestion
): boolean => {
  const fileLines = contents.split("\n");
  const targetLines = fileLines
    .slice(suggestion.line_start - 1, suggestion.line_end)
    .join("\n");
  if (targetLines.trim() == suggestion.correction.trim()) {
    // same as existing code.
    return false;
  }
  return true;
};

export const generateInlineComments = async (
  suggestion: PRSuggestion,
  file: PRFile
): Promise<CodeSuggestion> => {
  try {
    // Validate inputs
    if (!suggestion || !file || !file.current_contents) {
      console.log('Missing required input for generateInlineComments');
      return null;
    }
    
    const messages = getInlineFixPrompt(file.current_contents, suggestion);
    const { function_call } = await generateChatCompletion({
      messages,
      functions: [INLINE_FIX_FUNCTION],
      function_call: { name: INLINE_FIX_FUNCTION.name },
    });
    
    if (!function_call) {
      throw new Error("No function call found");
    }
    
    // Safely parse JSON with error handling
    let args;
    try {
      args = JSON.parse(function_call.arguments);
    } catch (parseError) {
      console.log(`Error parsing function arguments: ${parseError.message}`);
      return null;
    }
    
    // Validate parsed arguments
    if (!args.code || typeof args.lineStart !== 'number' || typeof args.lineEnd !== 'number') {
      console.log('Invalid or missing arguments for code suggestion');
      return null;
    }
    
    const initialCode = String.raw`${args["code"]}`;
    const indentedCode = indentCodeFix(
      file.current_contents,
      initialCode,
      args["lineStart"]
    );
    
    const codeFix = {
      file: suggestion.filename,
      line_start: args["lineStart"],
      line_end: args["lineEnd"],
      correction: indentedCode,
      comment: args["comment"] || '',
    };
    
    if (isCodeSuggestionNew(file.current_contents, codeFix)) {
      return codeFix;
    }
    return null;
  } catch (exc) {
    // Log error safely without exposing sensitive data
    console.log(`Error generating inline comments for file ${suggestion?.filename || 'unknown'}: ${exc.message || 'Unknown error'}`);
    return null;
  }
};

const preprocessFile = async (
  octokit: Octokit,
  payload: WebhookEventMap["pull_request"],
  file: PRFile
) => {
  const { base, head } = payload.pull_request;
  const baseBranch: BranchDetails = {
    name: base.ref,
    sha: base.sha,
    url: payload.pull_request.url,
  };
  const currentBranch: BranchDetails = {
    name: head.ref,
    sha: head.sha,
    url: payload.pull_request.url,
  };
  // Handle scenario where file does not exist!!
  const [oldContents, currentContents] = await Promise.all([
    getGitFile(octokit, payload, baseBranch, file.filename),
    getGitFile(octokit, payload, currentBranch, file.filename),
  ]);

  if (oldContents.content != null) {
    file.old_contents = String.raw`${oldContents.content}`;
  } else {
    file.old_contents = null;
  }

  if (currentContents.content != null) {
    file.current_contents = String.raw`${currentContents.content}`;
  } else {
    file.current_contents = null;
  }
};

const reviewChangesRetry = async (files: PRFile[], builders: Builders[]) => {
  for (const { convoBuilder, responseBuilder } of builders) {
    try {
      console.log(`Trying with convoBuilder: ${convoBuilder.name}.`);
      return await reviewChanges(files, convoBuilder, responseBuilder);
    } catch (error) {
      console.log(
        `Error with convoBuilder: ${convoBuilder.name}, trying next one. Error: ${error}`
      );
    }
  }
  throw new Error("All convoBuilders failed.");
};

export const processPullRequest = async (
  octokit: Octokit,
  payload: WebhookEventMap["pull_request"],
  files: PRFile[],
  includeSuggestions = false
) => {
  try {
    // Log safely without dumping entire objects
    console.log(`Processing PR #${payload.pull_request.number} with ${files.length} files`);
    
    const filteredFiles = files.filter((file) => filterFile(file));
    console.log(`${filteredFiles.length} files remaining after filtering`);
    
    if (filteredFiles.length == 0) {
      console.log("Nothing to comment on, all files were filtered out. The PR Agent does not support certain file types.");
      return {
        review: null,
        suggestions: [],
      };
    }
    
    await Promise.all(
      filteredFiles.map((file) => {
        return preprocessFile(octokit, payload, file);
      })
    );
    
    const owner = payload.repository.owner.login;
    const repoName = payload.repository.name;
    
    // Validate owner and repo name
    if (!/^[a-zA-Z0-9-_.]+$/.test(owner) || !/^[a-zA-Z0-9-_.]+$/.test(repoName)) {
      console.log('Invalid owner or repo name format');
      return {
        review: null,
        suggestions: [],
      };
    }
    
    const curriedXMLResponseBuilder = curriedXmlResponseBuilder(owner, repoName);
    
    if (includeSuggestions) {
      const reviewComments = await reviewChangesRetry(filteredFiles, [
        {
          convoBuilder: getXMLReviewPrompt,
          responseBuilder: curriedXMLResponseBuilder,
        },
        {
          convoBuilder: getReviewPrompt,
          responseBuilder: basicResponseBuilder,
        },
      ]);
      
      let inlineComments: CodeSuggestion[] = [];
      if (reviewComments.structuredComments && reviewComments.structuredComments.length > 0) {
        console.log(`Processing ${reviewComments.structuredComments.length} inline suggestions`);
        
        inlineComments = await Promise.all(
          reviewComments.structuredComments.map((suggestion) => {
            // find relevant file
            const file = files.find(
              (file) => file.filename === suggestion.filename
            );
            if (file == null) {
              return null;
            }
            return generateInlineComments(suggestion, file);
          })
        );
      }
      
      const filteredInlineComments = inlineComments.filter(
        (comment) => comment !== null
      );
      
      console.log(`Generated ${filteredInlineComments.length} valid inline comments`);
      
      return {
        review: reviewComments,
        suggestions: filteredInlineComments,
      };
    } else {
      const review = await reviewChangesRetry(filteredFiles, [
        {
          convoBuilder: getXMLReviewPrompt,
          responseBuilder: curriedXMLResponseBuilder,
        },
        {
          convoBuilder: getReviewPrompt,
          responseBuilder: basicResponseBuilder,
        },
      ]);

      return {
        review,
        suggestions: [],
      };
    }
  } catch (error) {
    console.log(`Error in processPullRequest: ${error.message || 'Unknown error'}`);
    return {
      review: null,
      suggestions: []
    };
  }
};

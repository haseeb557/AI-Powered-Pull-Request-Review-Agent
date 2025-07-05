import {
  BranchDetails,
  BuilderResponse,
  CodeSuggestion,
  Review,
  processGitFilepath,
} from "./constants";
import { Octokit } from "@octokit/rest";
import { WebhookEventMap } from "@octokit/webhooks-definitions/schema";

const postGeneralReviewComment = async (
  octokit: Octokit,
  payload: WebhookEventMap["pull_request"],
  review: string
) => {
  try {
    // Validate that review content is not empty
    if (!review || review.trim() === '') {
      console.log('Skipping empty review comment');
      return;
    }

    await octokit.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        issue_number: payload.pull_request.number,
        body: review,
        headers: {
          "x-github-api-version": "2022-11-28",
        },
      }
    );
  } catch (exc) {
    console.log(`Error posting general review comment: ${exc.message || 'Unknown error'}`);
  }
};

const postInlineComment = async (
  octokit: Octokit,
  payload: WebhookEventMap["pull_request"],
  suggestion: CodeSuggestion
) => {
  try {
    const line = suggestion.line_end;
    let startLine = null;
    if (suggestion.line_end != suggestion.line_start) {
      startLine = suggestion.line_start;
    }
    const suggestionBody = `${suggestion.comment}\n\`\`\`suggestion\n${suggestion.correction}`;

    await octokit.request(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/comments",
      {
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        pull_number: payload.pull_request.number,
        body: suggestionBody,
        commit_id: payload.pull_request.head.sha,
        path: suggestion.file,
        line: line,
        ...(startLine ? { start_line: startLine } : {}),
        // position: suggestion.line_start,
        // subject_type: "line",
        start_side: "RIGHT",
        side: "RIGHT",
        headers: {
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );
  } catch (exc) {
    console.log(`Error posting inline comment for file ${suggestion.file}: ${exc.message || 'Unknown error'}`);
  }
};

export const applyReview = async ({
  octokit,
  payload,
  review,
}: {
  octokit: Octokit;
  payload: WebhookEventMap["pull_request"];
  review: Review;
}) => {
  let commentPromise = null;
  const comment = review.review?.comment;
  if (comment != null) {
    commentPromise = postGeneralReviewComment(octokit, payload, comment);
  }
  const suggestionPromises = review.suggestions.map((suggestion) =>
    postInlineComment(octokit, payload, suggestion)
  );
  await Promise.all([
    ...(commentPromise ? [commentPromise] : []),
    ...suggestionPromises,
  ]);
};

const addLineNumbers = (contents: string) => {
  const rawContents = String.raw`${contents}`;
  const prepended = rawContents
    .split("\n")
    .map((line, idx) => `${idx + 1}: ${line}`)
    .join("\n");
  return prepended;
};

export const getGitFile = async (
  octokit: Octokit,
  payload: WebhookEventMap["issues"] | WebhookEventMap["pull_request"],
  branch: BranchDetails,
  filepath: string
) => {
  try {
    const response = await octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      {
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        path: filepath,
        ref: branch.name, // specify the branch name here
        headers: {
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );
    
    // Handle the different response types safely
    if (Array.isArray(response.data)) {
      // Directory response - no content to decode
      return { content: null, sha: null };
    }
    
    // Check if this is a file with content
    if (response.data.type === 'file' && response.data.content) {
      const decodedContent = Buffer.from(
        response.data.content,
        "base64"
      ).toString("utf8");
      return { content: decodedContent, sha: response.data.sha };
    }
    
    // If we reach here, we don't have content to decode
    return { content: null, sha: response.data.sha };
  } catch (exc) {
    if (exc.status === 404) {
      return { content: null, sha: null };
    }
    // Log only non-sensitive information about the error
    console.log(`Error fetching file ${filepath}: ${exc.message || 'Unknown error'}`);
    throw exc;
  }
};

export const getFileContents = async (
  octokit: Octokit,
  payload: WebhookEventMap["issues"],
  branch: BranchDetails,
  filepath: string
) => {
  const gitFile = await getGitFile(
    octokit,
    payload,
    branch,
    processGitFilepath(filepath)
  );
  const fileWithLines = `# ${filepath}\n${addLineNumbers(gitFile.content)}`;
  return { result: fileWithLines, functionString: `Opening file: ${filepath}` };
};

export const commentIssue = async (
  octokit: Octokit,
  payload: WebhookEventMap["issues"],
  comment: string
) => {
  await octokit.rest.issues.createComment({
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    issue_number: payload.issue.number,
    body: comment,
  });
};

export const createBranch = async (
  octokit: Octokit,
  payload: WebhookEventMap["issues"]
) => {
  let branchDetails = null;
  try {
    const title = payload.issue.title.replace(/\s/g, "-").substring(0, 15);

    const hash = Math.random().toString(36).substring(2, 7);
    const subName = `${title}-${hash}`.substring(0, 20);
    const branchName = `Code-Bot/${subName}`;
    // Get the default branch for the repository
    const { data: repo } = await octokit.rest.repos.get({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
    });

    // Get the commit SHA of the default branch
    const { data: ref } = await octokit.rest.git.getRef({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      ref: `heads/${repo.default_branch}`,
    });

    // Create a new branch from the commit SHA
    const { data: newBranch } = await octokit.rest.git.createRef({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      ref: `refs/heads/${branchName}`,
      sha: ref.object.sha,
    });

    // Log only necessary information
    console.log(`Created branch reference: ${branchName}`);

    branchDetails = {
      name: branchName,
      sha: newBranch.object.sha,
      url: newBranch.url,
    };
    
    // Validate owner and repo name to prevent URL manipulation
    const owner = payload.repository.owner.login;
    const repoName = payload.repository.name;
    
    // Simple validation of owner and repo name format
    if (!/^[a-zA-Z0-9-_.]+$/.test(owner) || !/^[a-zA-Z0-9-_.]+$/.test(repoName)) {
      throw new Error("Invalid owner or repository name format");
    }
    
    let branchUrl = `https://github.com/${owner}/${repoName}/tree/${branchName}`;
    const branchComment = `Branch created: [${branchName}](${branchUrl})`;
    await commentIssue(octokit, payload, branchComment);

    console.log(`Branch ${branchName} created`);
  } catch (exc) {
    console.log(`Error creating branch: ${exc.message || 'Unknown error'}`);
  }
  return branchDetails;
};

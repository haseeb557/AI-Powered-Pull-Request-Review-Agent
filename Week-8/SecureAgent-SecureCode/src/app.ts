import { Octokit } from "@octokit/rest";
import { createNodeMiddleware } from "@octokit/webhooks";
import { WebhookEventMap } from "@octokit/webhooks-definitions/schema";
import * as http from "http";
import { App } from "octokit";
import { Review } from "./constants";
import { env } from "./env";
import { processPullRequest } from "./review-agent";
import { applyReview } from "./reviews";

// This creates a new instance of the Octokit App class.
const reviewApp = new App({
  appId: env.GITHUB_APP_ID,
  privateKey: env.GITHUB_PRIVATE_KEY,
  webhooks: {
    secret: env.GITHUB_WEBHOOK_SECRET,
  },
});

// Security middleware to add secure headers to all responses
const addSecurityHeaders = (res: http.ServerResponse) => {
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  
  // Strict Transport Security - force HTTPS
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  
  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');
  
  // Cross-site scripting protection
  res.setHeader('X-XSS-Protection', '1; mode=block');
  
  // Restrict referrer information
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  // Set Content Security Policy
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'"
  );
};

const getChangesPerFile = async (payload: WebhookEventMap["pull_request"]) => {
  try {
    const octokit = await reviewApp.getInstallationOctokit(
      payload.installation.id
    );
    const { data: files } = await octokit.rest.pulls.listFiles({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      pull_number: payload.pull_request.number,
    });
    // Avoid logging entire payloads that might contain sensitive information
    console.log(`Retrieved ${files.length} changed files for PR #${payload.pull_request.number}`);
    return files;
  } catch (exc) {
    console.log(`Error retrieving files: ${exc.message || 'Unknown error'}`);
    return [];
  }
};

// This adds an event handler that your code will call later. When this event handler is called, it will log the event to the console. Then, it will use GitHub's REST API to add a comment to the pull request that triggered the event.
async function handlePullRequestOpened({
  octokit,
  payload,
}: {
  octokit: Octokit;
  payload: WebhookEventMap["pull_request"];
}) {
  console.log(
    `Received a pull request event for #${payload.pull_request.number}`
  );
  try {
    console.log(`Processing PR #${payload.pull_request.number} for repository: ${payload.repository.full_name}`);
    
    const files = await getChangesPerFile(payload);
    const review: Review = await processPullRequest(
      octokit,
      payload,
      files,
      true
    );
    await applyReview({ octokit, payload, review });
    console.log(`Review submitted successfully for PR #${payload.pull_request.number}`);
  } catch (exc) {
    console.log(`Error handling pull request #${payload.pull_request.number}: ${exc.message || 'Unknown error'}`);
  }
}

// This sets up a webhook event listener. When your app receives a webhook event from GitHub with a `X-GitHub-Event` header value of `pull_request` and an `action` payload value of `opened`, it calls the `handlePullRequestOpened` event handler that is defined above.
//@ts-ignore
reviewApp.webhooks.on("pull_request.opened", handlePullRequestOpened);

const port = process.env.PORT || 3000;
const reviewWebhook = `/api/review`;

const reviewMiddleware = createNodeMiddleware(reviewApp.webhooks, {
  path: "/api/review",
});

const server = http.createServer((req, res) => {
  // Add security headers to all responses
  addSecurityHeaders(res);
  
  if (req.url === reviewWebhook) {
    reviewMiddleware(req, res);
  } else {
    res.statusCode = 404;
    res.end("Not Found");
  }
});

// This creates a Node.js server that listens for incoming HTTP requests (including webhook payloads from GitHub) on the specified port. When the server receives a request, it executes the `middleware` function that you defined earlier. Once the server is running, it logs messages to the console to indicate that it is listening.
server.listen(port, () => {
  console.log(`Server is listening for events.`);
  console.log("Press Ctrl + C to quit.");
});

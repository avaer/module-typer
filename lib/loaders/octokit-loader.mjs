import { Octokit } from "@octokit/rest";

export const makeOctokitLoader = ({
  OCTOKIT_API,
}) => async function loadOctokitFile(githubUrl) {
  // Parse GitHub URL components
  const url = new URL(githubUrl);
  const [, owner, repo, , branch, ...pathParts] = url.pathname.split("/");
  const filePath = pathParts.join("/");

  // Use Octokit if API key is available
  const octokit = new Octokit({
    auth: OCTOKIT_API,
  });

  const response = await octokit.repos.getContent({
    owner,
    repo,
    path: filePath,
    ref: branch,
  });

  const content = Buffer.from(response.data.content, "base64").toString();
  return { content, error: null };
}

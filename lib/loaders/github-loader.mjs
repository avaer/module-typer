export async function loadGithubFile(githubUrl) {
  const rawUrl = new URL(githubUrl);
  rawUrl.hostname = "raw.githubusercontent.com";
  rawUrl.pathname = rawUrl.pathname.replace("/blob/", "/");

  const response = await fetch(rawUrl);

  if (!response.ok) {
    return {
      content: null,
      error: `Failed to fetch: ${response.statusText}`,
    };
  }

  const content = await response.text();
  return { content, error: null };
}
import { loadLocalFile } from './loaders/file-loader.mjs';
import { loadGithubFile } from './loaders/github-loader.mjs';
import { makeOctokitLoader } from './loaders/octokit-loader.mjs';

// Helper function to determine if a path is a GitHub URL
export function isGithubUrl(path) {
  return path.startsWith('https://github.com/');
}

// Function to choose the appropriate loader based on the path
export function getFileLoader(filePath, {
  OCTOKIT_API,
} = {}) {
  if (isGithubUrl(filePath)) {
    if (OCTOKIT_API) {
      return makeOctokitLoader({
        OCTOKIT_API,
      });
    } else {
      return loadGithubFile;
    }
  } else {
    return loadLocalFile;
  }
}
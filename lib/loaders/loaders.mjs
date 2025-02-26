import { loadLocalFile } from './loaders/file-loader.mjs';
import { loadGithubFile } from './loaders/github-loader.mjs';
import { makeOctokitLoader } from './loaders/octokit-loader.mjs';

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
import { loadLocalFile } from './file-loader.mjs';
import { loadGithubFile } from './github-loader.mjs';
import { makeOctokitLoader } from './octokit-loader.mjs';
import { isGithubUrl } from '../util.mjs';

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
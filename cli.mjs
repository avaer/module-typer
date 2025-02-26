import dotenv from 'dotenv';
import { fetchTypes } from './api.mjs';
import { getFileLoader } from './lib/util.mjs';

(async () => {
  dotenv.config();
  const p = process.argv[2];
  const loadFile = getFileLoader(p, {
    OCTOKIT_API: process.env.OCTOKIT_API,
  });
  const schema = await fetchTypes(p, {
    loadFile,
  });
  console.log(JSON.stringify(schema, null, 2));
})();
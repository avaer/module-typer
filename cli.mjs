import dotenv from 'dotenv';
import { fetchTypes } from './api.mjs';

(async () => {
  dotenv.config();
  const types = await fetchTypes(process.argv[2], {
    env: {
      OCTOKIT_API: process.env.OCTOKIT_API,
    },
  });
  console.log(types);
})();
import dotenv from 'dotenv';
import { fetchTypes } from './api.mjs';

(async () => {
  dotenv.config();
  const schema = await fetchTypes(process.argv[2], {
    env: {
      OCTOKIT_API: process.env.OCTOKIT_API,
    },
  });
  console.log(JSON.stringify(schema, null, 2));
})();
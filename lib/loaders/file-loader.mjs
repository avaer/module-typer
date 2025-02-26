import fs from 'fs/promises';

export async function loadLocalFile(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return { content, error: null };
  } catch (error) {
    return { content: null, error: error.message };
  }
}
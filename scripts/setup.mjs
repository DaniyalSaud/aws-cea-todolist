import { copyFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function setup() {
  for (const workspace of ['frontend', 'backend']) {
    const destination = new URL(`../${workspace}/.env`, import.meta.url);
    try { await access(destination); } catch {
      await copyFile(new URL(`../${workspace}/.env.example`, import.meta.url), destination);
      console.log(`Created ${workspace}/.env from the example.`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await setup();
  console.log('Configuration ready. Run npm run dev:local for a complete local setup.');
}

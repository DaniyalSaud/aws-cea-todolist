import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { setup } from './setup.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const databaseDir = fileURLToPath(new URL('../.local/postgres', import.meta.url));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Start this script with npm run dev:local.');
await setup();
await mkdir(new URL('../.local/', import.meta.url), { recursive: true });
const postgres = new EmbeddedPostgres({
  databaseDir,
  user: 'todo',
  password: 'localtodo',
  port: 5432,
  persistent: true,
  authMethod: 'scram-sha-256',
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  postgresFlags: ['-h', '127.0.0.1'],
  onLog: () => {},
  onError: (error) => console.error('Local PostgreSQL:', error)
});
let child;
let stopping = false;

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  if (child?.pid) {
    if (process.platform === 'win32') {
      await new Promise((resolve) => {
        const terminator = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        terminator.on('close', resolve);
        terminator.on('error', resolve);
      });
    } else child.kill('SIGTERM');
  }
  await postgres.stop().catch(() => {});
  process.exitCode = code;
}

process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });

try {
  try { await access(`${databaseDir}/PG_VERSION`); } catch { await postgres.initialise(); }
  await postgres.start();
  const client = postgres.getPgClient();
  await client.connect();
  try {
    const result = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', ['todo_app']);
    if (!result.rowCount) await postgres.createDatabase('todo_app');
  } finally { await client.end(); }
  console.log('Local PostgreSQL ready. Tasks persist in .local/postgres.');
  console.log('Open http://localhost:5173. Press Ctrl+C to stop the app and database.');
  // These overrides intentionally keep this shortcut local; npm run dev uses your .env settings.
  child = spawn(process.execPath, [npmCli, 'run', 'dev'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: 'postgresql://todo:localtodo@127.0.0.1:5432/todo_app', DB_SSL: 'false', NODE_ENV: 'development' }
  });
  child.on('exit', (code) => { void stop(code ?? 0); });
  child.on('error', (error) => { console.error(error.message); void stop(1); });
} catch (error) {
  console.error('Unable to start local development:', error instanceof Error ? error.message : error);
  await stop(1);
}

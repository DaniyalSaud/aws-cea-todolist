import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const listener = createServer();
await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const postgres = new EmbeddedPostgres({
  databaseDir: await mkdtemp(join(tmpdir(), 'everyday-e2e-')),
  port, user: 'e2e_user', password: 'e2e-only-password', persistent: false,
  authMethod: 'scram-sha-256', initdbFlags: ['--encoding=UTF8', '--locale=C'],
  postgresFlags: ['-h', '127.0.0.1'], onLog: () => {}, onError: () => {}
});
let child;
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  child?.kill('SIGTERM');
  await postgres.stop().catch(() => {});
  process.exitCode = code;
}
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });

try {
  await postgres.initialise();
  await postgres.start();
  await postgres.createDatabase('todo_e2e');
  child = spawn(process.execPath, ['dist/server.js'], {
    cwd: fileURLToPath(new URL('../backend/', import.meta.url)), stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test', PORT: '3002', DATABASE_URL: `postgresql://e2e_user:e2e-only-password@127.0.0.1:${port}/todo_e2e`, DB_SSL: 'false', CORS_ORIGINS: 'http://127.0.0.1:5174', TRUST_PROXY_HOPS: '0', RUN_MIGRATIONS: 'true' }
  });
  child.on('exit', (code) => { void stop(code ?? 0); });
  child.on('error', (error) => { console.error(error.message); void stop(1); });
} catch (error) { console.error(error); await stop(1); }

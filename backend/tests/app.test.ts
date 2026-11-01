import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { createPool } from '../src/database.js';
import { migrate } from '../src/migrate.js';
import { AttachmentService, MAX_ATTACHMENT_BYTES } from '../src/attachments.js';
import { LocalFileStorage, S3FileStorage } from '../src/storage.js';
import { S3Client } from '@aws-sdk/client-s3';

let postgres: EmbeddedPostgres;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>;
let databaseUrl: string;
let attachments: AttachmentService;
let storage: LocalFileStorage;
let uploadDirectory: string;

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

beforeAll(async () => {
  const port = await freePort();
  postgres = new EmbeddedPostgres({
    databaseDir: await mkdtemp(join(tmpdir(), 'everyday-api-test-')),
    user: 'test_user', password: 'test-only-password', port, persistent: false,
    authMethod: 'scram-sha-256', initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: ['-h', '127.0.0.1'], onLog: () => {}, onError: () => {}
  });
  await postgres.initialise();
  await postgres.start();
  await postgres.createDatabase('todo_test');
  databaseUrl = `postgresql://test_user:test-only-password@127.0.0.1:${port}/todo_test`;
  pool = createPool(readConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, DB_SSL: 'false' }));
  await migrate(pool);
  uploadDirectory = await mkdtemp(join(tmpdir(), 'everyday-api-files-'));
  storage = new LocalFileStorage(uploadDirectory);
  attachments = new AttachmentService(pool, storage);
  app = createApp(pool, { CORS_ORIGINS: ['http://localhost:5173'], TRUST_PROXY_HOPS: 0 }, attachments);
});

beforeEach(async () => { await attachments.cleanup(); await pool.query('TRUNCATE todos, attachment_cleanup'); });
afterAll(async () => {
  await attachments?.close();
  await pool?.end();
  await postgres?.stop();
  if (uploadDirectory) {
    const cleanupPath = resolve(uploadDirectory);
    if (dirname(cleanupPath) !== resolve(tmpdir()) || !basename(cleanupPath).startsWith('everyday-api-files-')) throw new Error('Unsafe temporary cleanup path.');
    await rm(cleanupPath, { recursive: true, force: true });
  }
});

describe('Express API with real PostgreSQL', () => {
  it('reports liveness and database readiness', async () => {
    expect((await request(app).get('/healthz')).body).toEqual({ status: 'ok' });
    expect((await request(app).get('/api/health')).body).toEqual({ status: 'ok', database: 'connected' });
  });

  it('starts with an empty list', async () => {
    const response = await request(app).get('/api/todos');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ todos: [] });
  });

  it('creates, edits, completes, reopens and deletes a persisted task', async () => {
    const created = await request(app).post('/api/todos').send({ title: '  Plan the week  ' });
    expect(created.status).toBe(201);
    expect(created.body.todo).toMatchObject({ title: 'Plan the week', completed: false });
    expect(created.body.todo.id).toMatch(/^[\da-f-]{36}$/);
    expect(Number.isNaN(Date.parse(created.body.todo.createdAt))).toBe(false);
    const id = created.body.todo.id as string;
    const edited = await request(app).patch(`/api/todos/${id}`).send({ title: 'Plan Monday', completed: true });
    expect(edited.status).toBe(200);
    expect(edited.body.todo).toMatchObject({ title: 'Plan Monday', completed: true });
    expect(new Date(edited.body.todo.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(created.body.todo.createdAt).getTime());
    const reconnected = new pg.Pool({ connectionString: databaseUrl });
    try {
      expect((await reconnected.query('SELECT title, completed FROM todos WHERE id = $1', [id])).rows)
        .toEqual([{ title: 'Plan Monday', completed: true }]);
    } finally { await reconnected.end(); }
    expect((await request(app).patch(`/api/todos/${id}`).send({ completed: false })).body.todo.completed).toBe(false);
    expect((await request(app).delete(`/api/todos/${id}`)).status).toBe(204);
    expect((await request(app).get('/api/todos')).body.todos).toEqual([]);
  });

  it('orders tasks with the newest first', async () => {
    await request(app).post('/api/todos').send({ title: 'First' });
    await request(app).post('/api/todos').send({ title: 'Second' });
    expect((await request(app).get('/api/todos')).body.todos.map((todo: { title: string }) => todo.title)).toEqual(['Second', 'First']);
  });

  it.each([{}, { title: '' }, { title: '   ' }, { title: 12 }, { title: 'x'.repeat(201) }, { title: 'Task', extra: true }])('rejects invalid task creation: %j', async (body) => {
    expect((await request(app).post('/api/todos').send(body)).status).toBe(400);
    expect((await request(app).get('/api/todos')).body.todos).toHaveLength(0);
  });

  it.each([{}, { completed: 'true' }, { title: ' ' }, { unknown: 'field' }])('rejects invalid edits: %j', async (body) => {
    const created = await request(app).post('/api/todos').send({ title: 'Keep me' });
    expect((await request(app).patch(`/api/todos/${created.body.todo.id}`).send(body)).status).toBe(400);
    expect((await request(app).get('/api/todos')).body.todos[0].title).toBe('Keep me');
  });

  it('handles malformed UUIDs and missing tasks', async () => {
    expect((await request(app).delete('/api/todos/not-a-uuid')).status).toBe(400);
    expect((await request(app).patch(`/api/todos/${randomUUID()}`).send({ completed: true })).status).toBe(404);
    expect((await request(app).delete(`/api/todos/${randomUUID()}`)).status).toBe(404);
  });

  it('clears completed tasks and preserves active tasks', async () => {
    const done = await request(app).post('/api/todos').send({ title: 'Completed task' });
    await request(app).patch(`/api/todos/${done.body.todo.id}`).send({ completed: true });
    await request(app).post('/api/todos').send({ title: 'Active task' });
    expect((await request(app).delete('/api/todos/completed')).body).toEqual({ deletedCount: 1 });
    expect((await request(app).get('/api/todos')).body.todos.map((todo: { title: string }) => todo.title)).toEqual(['Active task']);
    expect((await request(app).delete('/api/todos/completed')).body).toEqual({ deletedCount: 0 });
  });

  it('stores SQL and HTML as plain text', async () => {
    const title = "<script>alert('hello')</script> '; DROP TABLE todos; --";
    expect((await request(app).post('/api/todos').send({ title })).body.todo.title).toBe(title);
    expect((await request(app).get('/api/todos')).body.todos).toHaveLength(1);
  });

  it('returns JSON for malformed JSON, oversized bodies and missing routes', async () => {
    const malformed = await request(app).post('/api/todos').set('Content-Type', 'application/json').send('{');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toContain('valid JSON');
    expect((await request(app).post('/api/todos').send({ title: 'x'.repeat(20_000) })).status).toBe(413);
    expect((await request(app).get('/api/unknown')).status).toBe(404);
  });

  it('allows configured browser origins and rejects other origins', async () => {
    const allowed = await request(app).get('/api/todos').set('Origin', 'http://localhost:5173');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect((await request(app).get('/api/todos').set('Origin', 'https://other.example.com')).status).toBe(403);
    const preflight = await request(app).options('/api/todos').set('Origin', 'http://localhost:5173').set('Access-Control-Request-Method', 'PATCH');
    expect(preflight.status).toBe(204);
  });

  it('reruns migrations without losing existing tasks', async () => {
    await request(app).post('/api/todos').send({ title: 'Keep after migration' });
    await Promise.all([migrate(pool), migrate(pool)]);
    expect((await request(app).get('/api/todos')).body.todos[0].title).toBe('Keep after migration');
    expect((await pool.query('SELECT name FROM schema_migrations')).rowCount).toBe(2);
  });

  it('reports a database outage without exposing connection details', async () => {
    const disconnected = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await disconnected.end();
    const disconnectedApp = createApp(disconnected, { CORS_ORIGINS: [], TRUST_PROXY_HOPS: 0 }, new AttachmentService(disconnected, storage));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await request(disconnectedApp).get('/api/health')).status).toBe(503);
      const response = await request(disconnectedApp).get('/api/todos');
      expect(response.status).toBe(503);
      expect(response.body.error).not.toContain('password');
    } finally { log.mockRestore(); }
  });
});

describe('File attachments with PostgreSQL and actual disk storage', () => {
  it('uploads, persists, downloads, replaces and removes a task attachment', async () => {
    const created = await request(app).post('/api/todos').send({ title: 'Read the notes' });
    const id = created.body.todo.id as string;
    const uploaded = await request(app).post(`/api/todos/${id}/attachment`).attach('file', Buffer.from('First notes'), { filename: 'notes.txt', contentType: 'text/plain' });
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.todo.attachment).toEqual({ name: 'notes.txt', size: 11, contentType: 'text/plain' });
    expect(JSON.stringify(uploaded.body.todo)).not.toContain('todo-attachments/');
    const firstKey = (await pool.query('SELECT attachment_key FROM todos WHERE id = $1', [id])).rows[0].attachment_key as string;
    expect(await readFile(join(uploadDirectory, firstKey), 'utf8')).toBe('First notes');
    expect((await request(app).get('/api/todos')).body.todos[0].attachment.name).toBe('notes.txt');
    const link = await request(app).get(`/api/todos/${id}/attachment/download-url`);
    const download = await request(app).get(link.body.url as string);
    expect(download.status).toBe(200);
    expect(download.headers['content-disposition']).toMatch(/^attachment; filename="?notes\.txt"?$/);
    expect(download.headers['content-type']).toContain('application/octet-stream');
    expect(download.body.toString()).toBe('First notes');
    const replaced = await request(app).post(`/api/todos/${id}/attachment`).attach('file', Buffer.from('New notes'), 'new.txt');
    expect(replaced.body.todo.attachment.name).toBe('new.txt');
    await attachments.cleanup();
    await expect(readFile(join(uploadDirectory, firstKey))).rejects.toThrow();
    const removed = await request(app).delete(`/api/todos/${id}/attachment`);
    expect(removed.body.todo.attachment).toBeNull();
    await attachments.cleanup();
    expect((await request(app).get(`/api/todos/${id}/attachment/download-url`)).status).toBe(404);
    expect((await pool.query('SELECT * FROM attachment_cleanup')).rowCount).toBe(0);
  });

  it('rejects empty, missing, oversized and multiple files', async () => {
    const created = await request(app).post('/api/todos').send({ title: 'Upload tests' });
    const path = `/api/todos/${created.body.todo.id}/attachment`;
    expect((await request(app).post(path)).status).toBe(400);
    expect((await request(app).post(path).attach('file', Buffer.alloc(0), 'empty.txt')).status).toBe(400);
    expect((await request(app).post(path).attach('file', Buffer.alloc(MAX_ATTACHMENT_BYTES + 1), 'large.txt')).status).toBe(413);
    expect((await request(app).post(path).attach('file', Buffer.from('a'), 'a.txt').attach('file', Buffer.from('b'), 'b.txt')).status).toBe(400);
    expect((await request(app).post(`/api/todos/${randomUUID()}/attachment`).attach('file', Buffer.from('a'), 'a.txt')).status).toBe(404);
  });

  it('removes stored files when their tasks are deleted or completed tasks are cleared', async () => {
    const keys: string[] = [];
    for (const title of ['Delete me', 'Clear me']) {
      const created = await request(app).post('/api/todos').send({ title });
      const id = created.body.todo.id as string;
      await request(app).post(`/api/todos/${id}/attachment`).attach('file', Buffer.from('File'), 'file.txt');
      keys.push((await pool.query('SELECT attachment_key FROM todos WHERE id = $1', [id])).rows[0].attachment_key as string);
      if (title === 'Delete me') await request(app).delete(`/api/todos/${id}`);
      else {
        await request(app).patch(`/api/todos/${id}`).send({ completed: true });
        await request(app).delete('/api/todos/completed');
      }
    }
    await attachments.cleanup();
    for (const key of keys) await expect(readFile(join(uploadDirectory, key))).rejects.toThrow();
  });

  it('keeps an existing attachment when storage fails and retries cleanup after an outage', async () => {
    const created = await request(app).post('/api/todos').send({ title: 'Keep attachment' });
    const id = created.body.todo.id as string;
    await request(app).post(`/api/todos/${id}/attachment`).attach('file', Buffer.from('Original'), 'original.txt');
    const put = vi.spyOn(storage, 'put').mockRejectedValue(new Error('Storage unavailable'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await request(app).post(`/api/todos/${id}/attachment`).attach('file', Buffer.from('Replacement'), 'replacement.txt')).status).toBe(503);
      expect((await request(app).get('/api/todos')).body.todos[0].attachment.name).toBe('original.txt');
      await attachments.cleanup();
      const remove = vi.spyOn(storage, 'remove').mockRejectedValue(new Error('Storage unavailable'));
      try {
        await request(app).delete(`/api/todos/${id}`);
        await attachments.cleanup();
        expect((await pool.query('SELECT * FROM attachment_cleanup')).rowCount).toBe(1);
      } finally { remove.mockRestore(); }
      await attachments.cleanup();
      expect((await pool.query('SELECT * FROM attachment_cleanup')).rowCount).toBe(0);
    } finally { put.mockRestore(); log.mockRestore(); }
  });

  it('uploads to the S3 adapter, generates a signed private download and deletes the stored object', async () => {
    const objects = new Map<string, Buffer>();
    const authorizations: string[] = [];
    const s3 = createHttpServer(async (incoming, outgoing) => {
      const url = new URL(incoming.url!, 'http://localhost');
      const key = decodeURIComponent(url.pathname);
      if (incoming.headers.authorization) authorizations.push(incoming.headers.authorization);
      if (incoming.method === 'PUT') {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        objects.set(key, Buffer.concat(chunks));
        outgoing.setHeader('ETag', '"test-etag"');
        outgoing.end();
      } else if (incoming.method === 'GET' && objects.has(key)) {
        outgoing.setHeader('Content-Type', url.searchParams.get('response-content-type') ?? 'application/octet-stream');
        outgoing.end(objects.get(key));
      } else if (incoming.method === 'DELETE') {
        objects.delete(key);
        outgoing.statusCode = 204;
        outgoing.end();
      } else { outgoing.statusCode = 404; outgoing.end(); }
    });
    await new Promise<void>((done) => s3.listen(0, '127.0.0.1', done));
    const port = (s3.address() as { port: number }).port;
    const s3Storage = new S3FileStorage('private-test-bucket', new S3Client({
      region: 'us-east-1', endpoint: `http://127.0.0.1:${port}`, forcePathStyle: true,
      credentials: { accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-key' }
    }));
    const s3Attachments = new AttachmentService(pool, s3Storage);
    const s3App = createApp(pool, { CORS_ORIGINS: [], TRUST_PROXY_HOPS: 0 }, s3Attachments);
    try {
      const created = await request(s3App).post('/api/todos').send({ title: 'S3 task' });
      const id = created.body.todo.id as string;
      const uploaded = await request(s3App).post(`/api/todos/${id}/attachment`).attach('file', Buffer.from('Private S3 notes'), 'private.txt');
      expect(uploaded.status).toBe(200);
      expect(objects.size).toBe(1);
      expect(authorizations[0]).toContain('AWS4-HMAC-SHA256');
      const response = await request(s3App).get(`/api/todos/${id}/attachment/download-url`);
      const signed = new URL(response.body.url as string);
      expect(signed.pathname).toContain(`/private-test-bucket/todo-attachments/${id}/`);
      expect(signed.searchParams.get('X-Amz-Expires')).toBe('60');
      expect(signed.searchParams.get('X-Amz-Signature')).toBeTruthy();
      expect(signed.searchParams.get('response-content-disposition')).toContain("attachment; filename*=UTF-8''private.txt");
      expect(await (await fetch(signed)).text()).toBe('Private S3 notes');
      expect((await request(s3App).delete(`/api/todos/${id}`)).status).toBe(204);
      await s3Attachments.cleanup();
      expect(objects.size).toBe(0);
    } finally {
      await s3Attachments.close();
      await new Promise<void>((done) => s3.close(() => done()));
    }
  });
});

describe('Configuration', () => {
  it('defaults to verified TLS in production and accepts exact CORS origins', () => {
    const config = readConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://user:secret@db.example.com/todos', CORS_ORIGINS: 'https://todo.example.com, https://other.example.com', AWS_REGION: 'us-east-1', S3_BUCKET_NAME: 'todo-files' });
    expect(config.DB_SSL).toBe(true);
    expect(config.ATTACHMENT_STORAGE).toBe('s3');
    expect(config.CORS_ORIGINS).toEqual(['https://todo.example.com', 'https://other.example.com']);
  });

  it('rejects SSL URL parameters that could override certificate verification', () => {
    expect(() => readConfig({ DATABASE_URL: 'postgresql://user:secret@db.example.com/todos?sslmode=no-verify' })).toThrow('without SSL query parameters');
  });

  it('rejects invalid config without printing credentials', () => {
    try { readConfig({ DATABASE_URL: 'https://user:top-secret@example.com', PORT: 'invalid' }); }
    catch (error) { expect((error as Error).message).not.toContain('top-secret'); return; }
    throw new Error('Expected validation to fail.');
  });

  it('requires a region and private bucket name for S3 storage', () => {
    expect(() => readConfig({ DATABASE_URL: 'postgresql://user:secret@db.example.com/todos', ATTACHMENT_STORAGE: 's3' })).toThrow('Required when attachment storage is S3');
  });
});

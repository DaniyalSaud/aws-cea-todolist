import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { createPool } from '../src/database.js';
import { migrate } from '../src/migrate.js';

let postgres: EmbeddedPostgres;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>;
let databaseUrl: string;

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
  app = createApp(pool, { CORS_ORIGINS: ['http://localhost:5173'], TRUST_PROXY_HOPS: 0 });
});

beforeEach(async () => { await pool.query('TRUNCATE todos'); });
afterAll(async () => { await pool?.end(); await postgres?.stop(); });

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
    expect((await pool.query('SELECT name FROM schema_migrations')).rowCount).toBe(1);
  });

  it('reports a database outage without exposing connection details', async () => {
    const disconnected = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await disconnected.end();
    const disconnectedApp = createApp(disconnected, { CORS_ORIGINS: [], TRUST_PROXY_HOPS: 0 });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await request(disconnectedApp).get('/api/health')).status).toBe(503);
      const response = await request(disconnectedApp).get('/api/todos');
      expect(response.status).toBe(503);
      expect(response.body.error).not.toContain('password');
    } finally { log.mockRestore(); }
  });
});

describe('Configuration', () => {
  it('defaults to verified TLS in production and accepts exact CORS origins', () => {
    const config = readConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://user:secret@db.example.com/todos', CORS_ORIGINS: 'https://todo.example.com, https://other.example.com' });
    expect(config.DB_SSL).toBe(true);
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
});

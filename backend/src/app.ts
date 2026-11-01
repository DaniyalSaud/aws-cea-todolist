import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import pg from 'pg';
import multer from 'multer';
import { z } from 'zod';
import type { Config } from './config.js';
import { AttachmentService, MAX_ATTACHMENT_BYTES, todoColumns } from './attachments.js';

const title = z.string().trim().min(1, 'Enter a task.').max(200, 'Keep your task to 200 characters or fewer.');
const createSchema = z.object({ title }).strict();
const updateSchema = z.object({ title: title.optional(), completed: z.boolean().optional() }).strict()
  .refine((value) => value.title !== undefined || value.completed !== undefined, 'Provide a title or completed status.');
const columns = todoColumns;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1, fields: 0, parts: 1 } }).single('file');

function parse<T>(schema: z.ZodType<T>, value: unknown, response: Response): T | undefined {
  const result = schema.safeParse(value);
  if (!result.success) {
    response.status(400).json({ error: result.error.issues[0]?.message ?? 'Invalid request.' });
    return undefined;
  }
  return result.data;
}

function todoId(request: Request, response: Response) {
  return parse(z.uuid(), request.params.id, response);
}

export function createApp(pool: pg.Pool, config: Pick<Config, 'CORS_ORIGINS' | 'TRUST_PROXY_HOPS'>, attachments: AttachmentService) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY_HOPS);
  app.use(helmet());
  app.use(cors({
    origin(origin, callback) {
      if (!origin || config.CORS_ORIGINS.includes(origin)) return callback(null, true);
      const error = Object.assign(new Error('This origin is not allowed.'), { status: 403 });
      callback(error);
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    maxAge: 86400
  }));
  app.use('/api', (_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/healthz', (_request, response) => response.json({ status: 'ok' }));
  app.get('/api/health', async (_request, response) => {
    try {
      await pool.query('SELECT 1');
      response.json({ status: 'ok', database: 'connected' });
    } catch {
      response.status(503).json({ status: 'unavailable', database: 'disconnected' });
    }
  });
  app.use('/api', rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many requests. Please wait a moment and try again.' }
  }));
  app.use(express.json({ limit: '16kb' }));

  app.get('/api/todos', async (_request, response) => {
    const result = await pool.query(`SELECT ${columns} FROM todos ORDER BY created_at DESC, id DESC`);
    response.json({ todos: result.rows });
  });

  app.post('/api/todos', async (request, response) => {
    const body = parse(createSchema, request.body, response);
    if (!body) return;
    const result = await pool.query(
      `INSERT INTO todos (id, title) VALUES ($1, $2) RETURNING ${columns}`,
      [randomUUID(), body.title]
    );
    response.status(201).json({ todo: result.rows[0] });
  });

  app.delete('/api/todos/completed', async (_request, response) => {
    response.json({ deletedCount: await attachments.deleteTasks(true) });
  });

  app.patch('/api/todos/:id', async (request, response) => {
    const id = todoId(request, response);
    if (!id) return;
    const body = parse(updateSchema, request.body, response);
    if (!body) return;
    const result = await pool.query(
      `UPDATE todos SET title = COALESCE($1, title), completed = COALESCE($2, completed),
        updated_at = NOW() WHERE id = $3 RETURNING ${columns}`,
      [body.title ?? null, body.completed ?? null, id]
    );
    if (!result.rows[0]) { response.status(404).json({ error: 'This task no longer exists.' }); return; }
    response.json({ todo: result.rows[0] });
  });

  app.delete('/api/todos/:id', async (request, response) => {
    const id = todoId(request, response);
    if (!id) return;
    const count = await attachments.deleteTasks(false, id);
    if (!count) { response.status(404).json({ error: 'This task no longer exists.' }); return; }
    response.status(204).end();
  });

  const uploadLimit = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Please wait a moment before uploading another file.' } });
  app.post('/api/todos/:id/attachment', uploadLimit, upload, async (request, response) => {
    const id = todoId(request, response);
    if (!id) return;
    if (!request.file || !request.file.size) { response.status(400).json({ error: 'Choose a non-empty file to attach.' }); return; }
    const todo = await attachments.upload(id, request.file);
    if (!todo) { response.status(404).json({ error: 'This task no longer exists.' }); return; }
    response.json({ todo });
  });

  app.delete('/api/todos/:id/attachment', async (request, response) => {
    const id = todoId(request, response);
    if (!id) return;
    const todo = await attachments.remove(id);
    if (!todo) { response.status(404).json({ error: 'This task no longer exists.' }); return; }
    response.json({ todo });
  });

  app.get('/api/todos/:id/attachment/download-url', async (request, response) => {
    const id = todoId(request, response);
    if (!id) return;
    const attachment = await attachments.get(id);
    if (!attachment) { response.status(404).json({ error: 'No file is attached to this task.' }); return; }
    response.json({ url: attachment.destination.kind === 'url' ? attachment.destination.url : `/api/todos/${id}/attachment` });
  });

  app.get('/api/todos/:id/attachment', async (request, response) => {
    const id = todoId(request, response);
    if (!id) return;
    const attachment = await attachments.get(id);
    if (!attachment) { response.status(404).json({ error: 'No file is attached to this task.' }); return; }
    if (attachment.destination.kind === 'url') response.redirect(attachment.destination.url);
    else {
      response.type('application/octet-stream');
      response.download(attachment.destination.path, attachment.name);
    }
  });

  app.use((_request, response) => response.status(404).json({ error: 'Route not found.' }));

  const handleError: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (response.headersSent) { _next(error); return; }
    const failure = error as { status?: number; type?: string; code?: string };
    if (error instanceof multer.MulterError) {
      response.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
        error: error.code === 'LIMIT_FILE_SIZE' ? 'Choose a file smaller than 5 MB.' : 'Attach one file at a time using the file field.'
      });
    } else if (failure.type === 'entity.parse.failed') {
      response.status(400).json({ error: 'The request must contain valid JSON.' });
    } else if (failure.status === 413) {
      response.status(413).json({ error: 'The request is too large.' });
    } else if (failure.status === 403) {
      response.status(403).json({ error: 'This origin is not allowed.' });
    } else {
      console.error('API request failed.', { code: failure.code ?? 'unknown' });
      response.status(503).json({ error: 'Unable to reach your tasks. Please try again in a moment.' });
    }
  };
  app.use(handleError);
  return app;
}

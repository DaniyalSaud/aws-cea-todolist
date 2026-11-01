import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FileStorage } from './storage.js';

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const todoColumns = `id, title, completed, created_at AS "createdAt", updated_at AS "updatedAt",
  CASE WHEN attachment_key IS NULL THEN NULL ELSE json_build_object(
    'name', attachment_name, 'size', attachment_size, 'contentType', attachment_type
  ) END AS attachment`;

export class AttachmentService {
  private cleanupTask?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly pool: pg.Pool, readonly storage: FileStorage) {}

  async upload(id: string, file: Express.Multer.File) {
    const filename = file.originalname.replace(/\\/g, '/').split('/').at(-1)?.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200) || 'attachment';
    const key = `todo-attachments/${id}/${randomUUID()}`;
    const client = await this.pool.connect();
    let uploadStarted = false;
    try {
      await client.query('BEGIN');
      const existing = await client.query<{ attachment_key: string | null }>('SELECT attachment_key FROM todos WHERE id = $1 FOR UPDATE', [id]);
      if (!existing.rows[0]) {
        await client.query('ROLLBACK');
        return undefined;
      }
      uploadStarted = true;
      await this.storage.put(key, file.buffer);
      const result = await client.query(
        `UPDATE todos SET attachment_key = $2, attachment_name = $3, attachment_type = $4,
          attachment_size = $5, updated_at = NOW() WHERE id = $1 RETURNING ${todoColumns}`,
        [id, key, filename, file.mimetype || 'application/octet-stream', file.size]
      );
      if (existing.rows[0].attachment_key) {
        await client.query('INSERT INTO attachment_cleanup (key) VALUES ($1) ON CONFLICT DO NOTHING', [existing.rows[0].attachment_key]);
      }
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      if (uploadStarted) {
        // If storage succeeded but the transaction failed, retain a durable cleanup record.
        await client.query('INSERT INTO attachment_cleanup (key) VALUES ($1) ON CONFLICT DO NOTHING', [key]).catch(() => {});
      }
      throw error;
    } finally {
      client.release();
      void this.cleanup();
    }
  }

  async remove(id: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query<{ attachment_key: string | null }>('SELECT attachment_key FROM todos WHERE id = $1 FOR UPDATE', [id]);
      if (!existing.rows[0]) { await client.query('ROLLBACK'); return undefined; }
      if (existing.rows[0].attachment_key) await client.query('INSERT INTO attachment_cleanup (key) VALUES ($1) ON CONFLICT DO NOTHING', [existing.rows[0].attachment_key]);
      const result = await client.query(`UPDATE todos SET attachment_key = NULL, attachment_name = NULL,
        attachment_type = NULL, attachment_size = NULL, updated_at = NOW() WHERE id = $1 RETURNING ${todoColumns}`, [id]);
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); void this.cleanup(); }
  }

  async get(id: string) {
    const result = await this.pool.query<{ attachment_key: string; attachment_name: string }>(
      'SELECT attachment_key, attachment_name FROM todos WHERE id = $1 AND attachment_key IS NOT NULL', [id]
    );
    const attachment = result.rows[0];
    if (!attachment) return undefined;
    return { name: attachment.attachment_name, destination: await this.storage.download(attachment.attachment_key, attachment.attachment_name) };
  }

  async deleteTasks(completedOnly: boolean, id?: string) {
    const result = await this.pool.query<{ count: number }>(`WITH deleted AS (
      DELETE FROM todos WHERE ${completedOnly ? 'completed = TRUE' : 'id = $1'} RETURNING attachment_key
    ), queued AS (
      INSERT INTO attachment_cleanup (key) SELECT attachment_key FROM deleted WHERE attachment_key IS NOT NULL
      ON CONFLICT DO NOTHING
    ) SELECT count(*)::int AS count FROM deleted`, completedOnly ? [] : [id]);
    void this.cleanup();
    return result.rows[0]?.count ?? 0;
  }

  cleanup(): Promise<void> {
    if (this.cleanupTask) return this.cleanupTask;
    this.cleanupTask = this.drainCleanup().finally(() => { this.cleanupTask = undefined; });
    return this.cleanupTask;
  }

  private async drainCleanup() {
    try {
      const pending = await this.pool.query<{ key: string }>(`SELECT key FROM attachment_cleanup
        WHERE NOT EXISTS (SELECT 1 FROM todos WHERE attachment_key = attachment_cleanup.key)
        ORDER BY queued_at LIMIT 50`);
      for (const { key } of pending.rows) {
        try {
          await this.storage.remove(key);
          await this.pool.query('DELETE FROM attachment_cleanup WHERE key = $1', [key]);
        } catch {
          await this.pool.query('UPDATE attachment_cleanup SET attempts = attempts + 1 WHERE key = $1', [key]);
          console.error('Attachment cleanup failed; queued for retry.');
        }
      }
    } catch { console.error('Attachment cleanup deferred; database unavailable.'); }
  }

  startCleanup() {
    void this.cleanup();
    this.timer = setInterval(() => { void this.cleanup(); }, 60_000);
    this.timer.unref();
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    await this.cleanupTask;
    this.storage.close();
  }
}

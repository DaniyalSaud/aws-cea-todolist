import { access, mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from './config.js';

export interface FileStorage {
  put(key: string, body: Buffer): Promise<void>;
  remove(key: string): Promise<void>;
  download(key: string, filename: string): Promise<{ kind: 'url'; url: string } | { kind: 'file'; path: string }>;
  close(): void;
}

export class LocalFileStorage implements FileStorage {
  private readonly directory: string;
  constructor(directory: string) { this.directory = resolve(directory); }

  private path(key: string) {
    const path = resolve(this.directory, key);
    if (!path.startsWith(`${this.directory}${sep}`)) throw new Error('Invalid attachment key.');
    return path;
  }

  async put(key: string, body: Buffer) {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body, { flag: 'wx' });
  }

  async remove(key: string) {
    await unlink(this.path(key)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  async download(key: string, _filename: string): Promise<{ kind: 'file'; path: string }> {
    const path = this.path(key);
    await access(path);
    return { kind: 'file', path };
  }

  close() { /* No persistent connections. */ }
}

export class S3FileStorage implements FileStorage {
  constructor(private readonly bucket: string, private readonly client: S3Client) {}

  async put(key: string, body: Buffer) {
    // The private bucket's default encryption applies. Files are never made public.
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: body, ContentType: 'application/octet-stream'
    }), { abortSignal: AbortSignal.timeout(30_000) });
  }

  async remove(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      { abortSignal: AbortSignal.timeout(10_000) });
  }

  async download(key: string, filename: string): Promise<{ kind: 'url'; url: string }> {
    const encoded = encodeURIComponent(filename).replace(/['()*]/g, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    const url = await getSignedUrl(this.client, new GetObjectCommand({
      Bucket: this.bucket, Key: key,
      ResponseContentDisposition: `attachment; filename*=UTF-8''${encoded}`,
      ResponseContentType: 'application/octet-stream'
    }), { expiresIn: 60 });
    return { kind: 'url', url };
  }

  close() { this.client.destroy(); }
}

export function createStorage(config: Config): FileStorage {
  if (config.ATTACHMENT_STORAGE === 's3') {
    return new S3FileStorage(config.S3_BUCKET_NAME!, new S3Client({ region: config.AWS_REGION, maxAttempts: 3 }));
  }
  return new LocalFileStorage(config.LOCAL_UPLOAD_DIR);
}

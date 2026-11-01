import 'dotenv/config';
import { z } from 'zod';

const boolean = z.enum(['true', 'false']).transform((value) => value === 'true');
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.string().url().refine((value) => {
    const url = new URL(value);
    return ['postgres:', 'postgresql:'].includes(url.protocol)
      && !['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert'].some((key) => url.searchParams.has(key));
  }, 'Use a PostgreSQL URL without SSL query parameters; configure TLS with DB_SSL and DB_SSL_CA_PATH.'),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173').transform((value) =>
    value.split(',').map((origin) => origin.trim()).filter(Boolean)
  ).pipe(z.array(z.string().url().refine((value) => new URL(value).origin === value,
    'Use an exact origin without a trailing slash or path.'))),
  DB_SSL: boolean.optional(),
  DB_SSL_CA_PATH: z.string().min(1).optional(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  RUN_MIGRATIONS: boolean.default(true)
});

export function readConfig(environment: NodeJS.ProcessEnv = process.env) {
  const result = schema.safeParse(environment);
  if (!result.success) {
    // Never include the input values: DATABASE_URL can contain credentials.
    throw new Error(`Invalid configuration: ${result.error.issues.map((issue) =>
      `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
  return {
    ...result.data,
    DB_SSL: result.data.DB_SSL ?? result.data.NODE_ENV === 'production'
  };
}

export type Config = ReturnType<typeof readConfig>;

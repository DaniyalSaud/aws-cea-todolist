# Everyday

A simple, responsive to-do list built with **React + TypeScript** in `frontend/`, **Express + TypeScript** in `backend/`, and **PostgreSQL**. Tasks are saved in the database and survive page refreshes and application restarts.

Add, edit, complete, reopen, and delete tasks; filter active/completed tasks; clear completed tasks; and see your progress. The interface supports keyboard navigation and mobile screens, and preserves your draft if a save fails.

This is one shared list with no sign-in. Everyone who can reach the API can view and change the list. For a personal AWS deployment, restrict access through your network or load balancer; add authentication and user-scoped tasks if you need separate private lists.

## Run locally — no Docker needed

Install **Node.js 22.13+** (Node 24 LTS recommended), then run these commands from the repository root:

```sh
npm install
npm run dev:local
```

Open **http://localhost:5173**. This command creates the two `.env` files if missing, starts a real local PostgreSQL 17 database, applies migrations, and starts Express on port `3001` and Vite on port `5173`. Press Ctrl+C to stop everything. Data stays in `.local/postgres/`.

The embedded PostgreSQL package downloads a binary for your operating system during installation, so allow npm installation scripts. Run it as a normal OS user; PostgreSQL cannot run as root. The shortcut deliberately uses the local database credentials and disables database TLS. It never connects to your configured RDS database.

If you already have PostgreSQL, use the environment examples instead:

```sh
npm install
npm run setup
# Edit backend/.env with your PostgreSQL connection settings.
npm run dev
```

Create the `todo_app` database before using an existing PostgreSQL server. The backend automatically applies versioned migrations when it starts. `npm run db:migrate` runs them separately. Do not run the embedded database and Docker database at the same time: both use port `5432`.

## Run with Docker

With Docker and Docker Compose installed:

```sh
docker compose up --build -d
```

Open **http://localhost:8080**. Compose starts PostgreSQL, Express, and the built React app served by Nginx. Nginx forwards `/api/*` to Express. Startup waits for the database and API health checks. Tasks persist in the `todos-db` volume.

```sh
docker compose down
```

This stops the containers while keeping the database volume. The credentials in `compose.yaml` are for local development. For AWS, use RDS and deployment secrets as described below.

## Configuration

Only the backend connects to PostgreSQL. Never put a database password or URL in a frontend `VITE_*` variable: these values are public after the frontend is built.

| Backend variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Required PostgreSQL connection URL, e.g. `postgresql://USER:PASSWORD@HOST:5432/todo_app`. Percent-encode special characters in credentials. |
| `NODE_ENV` | `development`, `test`, or `production`. |
| `PORT` | Express port; defaults to `3001`. |
| `CORS_ORIGINS` | Comma-separated exact browser origins, e.g. `https://todo.example.com`. No trailing slashes. Defaults to localhost/127.0.0.1 on port `5173`. |
| `DB_SSL` | `true` enables TLS **with certificate verification**; defaults to true in production. Set false only for a local database. |
| `DB_SSL_CA_PATH` | Path to a PEM CA bundle. For RDS, use the AWS RDS global bundle. Included at `/app/certs/global-bundle.pem` in the backend Docker image. |
| `DB_POOL_MAX` | Maximum PostgreSQL connections per backend replica; defaults to `10`. Size this with RDS capacity and replica count in mind. |
| `TRUST_PROXY_HOPS` | Defaults to `0`. Use `1` behind one trusted ALB or Nginx proxy, and restrict direct API access. |
| `RUN_MIGRATIONS` | Defaults to `true`. Set false when a separate deployment step applies migrations. |

Do not add `sslmode`, `ssl`, `sslcert`, `sslkey`, or `sslrootcert` query parameters to `DATABASE_URL`; the backend rejects them so they cannot override verified TLS settings. Keep the AWS CA bundle current by rebuilding the image or rerunning `npm run rds:ca` for a deployment outside Docker.

| Frontend variable | Purpose |
| --- | --- |
| `VITE_API_URL` | Leave empty for `/api` on the same origin. For separate hosting, set the API origin, e.g. `https://api.example.com`, **before building**. Do not include `/api`. |
| `API_PROXY_TARGET` | Vite development proxy target; defaults to `http://127.0.0.1:3001`. |

The frontend Docker image also accepts runtime `API_UPSTREAM` (`backend:3001` by default) and `DNS_RESOLVER` (`127.0.0.11` for Docker). These configure Nginx's API proxy. When using AWS service discovery, set the upstream to the backend service hostname/port and the resolver to your VPC's DNS resolver. They are unnecessary when an ALB routes API requests directly to Express.

## Deploy on AWS with RDS PostgreSQL

The app is prepared for RDS **PostgreSQL 17**. MySQL requires a different driver and schema; choose PostgreSQL when creating the RDS instance. AWS infrastructure is not provisioned by this repository.

A straightforward deployment uses an HTTPS Application Load Balancer, two ECS/Fargate services (frontend and backend), and a private RDS instance:

```text
Browser → HTTPS ALB ── /api and /api/* → Express :3001 → private RDS PostgreSQL :5432
                   └─ other paths    → React/Nginx :8080
```

1. Create an RDS PostgreSQL instance in the same VPC as the backend. Set the initial database name to `todo_app`, enable encryption and automated backups, and keep public access disabled. Allow inbound database port `5432` only from the backend service's security group. Enable/enforce SSL on the RDS instance.
2. Store the connection URL in AWS Secrets Manager or SSM Parameter Store. Supply it to the backend as `DATABASE_URL`; grant the ECS task execution role access to the specific secret. Use the RDS DNS endpoint as the host, so hostname verification works.
3. Build both images from the **repository root**, then push them to your ECR repositories:

   ```sh
   docker build -f backend/Dockerfile -t everyday-backend .
   docker build -f frontend/Dockerfile -t everyday-frontend .
   ```

4. Run the backend image with:

   ```dotenv
   NODE_ENV=production
   PORT=3001
   DATABASE_URL=postgresql://USER:ENCODED_PASSWORD@YOUR_RDS_ENDPOINT:5432/todo_app
   DB_SSL=true
   DB_SSL_CA_PATH=/app/certs/global-bundle.pem
   CORS_ORIGINS=https://todo.example.com
   TRUST_PROXY_HOPS=1
   DB_POOL_MAX=10
   RUN_MIGRATIONS=true
   ```

   `DATABASE_URL` should come from the task definition's **secrets** configuration. Allow backend port `3001` only from the ALB's security group. Send backend logs to CloudWatch. Migrations use a PostgreSQL advisory lock, so concurrent startup by multiple replicas is safe. The migration user needs schema/table creation rights. With a restricted runtime database user, apply migrations first using a separate migration role, grant the runtime user SELECT/INSERT/UPDATE/DELETE on `todos`, and set `RUN_MIGRATIONS=false`.

5. Run the frontend image on port `8080`. Add ALB listener rules for `/api` and `/api/*` to the backend target group; the default rule goes to the frontend target group. Set backend target health checks to **`/api/health`**, frontend health checks to **`/healthz`**. Build the frontend with an empty `VITE_API_URL` for this setup; no API hostname is compiled into the app.
6. Attach an ACM TLS certificate to the ALB, redirect HTTP to HTTPS, and point your domain at the load balancer. Set `CORS_ORIGINS` to the actual frontend origin. If your backend runs in private subnets, provide NAT or VPC endpoints for ECR, logs, and secrets access as needed.
7. Verify `https://todo.example.com/api/health` reports `{"status":"ok","database":"connected"}`, then create a task, reload, complete it, and delete it through the interface.

Alternatively, serve `frontend/dist` from a private S3 bucket through CloudFront and deploy the backend separately. Build with `VITE_API_URL=https://api.example.com`, configure backend CORS for your CloudFront/custom domain, and provide an HTTPS API endpoint. Use `index.html` for SPA navigation fallbacks.

For running Node directly on an EC2 instance:

```sh
npm ci
npm run build
npm run rds:ca
# Configure backend/.env using the production values above.
# Set DB_SSL_CA_PATH to the absolute path of certs/global-bundle.pem.
npm run start -w backend
```

Serve `frontend/dist` using a web server/CloudFront, run the backend under a service manager, and configure HTTPS/proxy routing. `vite preview` is for local build previews, not production hosting.

## API

All task responses use camelCase timestamps (`createdAt`, `updatedAt`). Titles are trimmed and must contain 1–200 characters. Updates accept a title, a boolean completed state, or both. SQL queries use parameters.

| Method | Route | Request / response |
| --- | --- | --- |
| GET | `/api/todos` | `{ "todos": [...] }`, newest first |
| POST | `/api/todos` | `{ "title": "Go for a walk" }` → 201 `{ "todo": {...} }` |
| PATCH | `/api/todos/:id` | `{ "completed": true }` or `{ "title": "New title" }` → `{ "todo": {...} }` |
| DELETE | `/api/todos/:id` | 204, no response body |
| DELETE | `/api/todos/completed` | `{ "deletedCount": 2 }` |
| GET | `/api/health` | Database readiness: 200 or 503 |
| GET | `/healthz` | Process liveness |

Errors return JSON `{ "error": "..." }` with appropriate 400/403/404/413/429/503 status codes. A per-process rate limit allows 300 API requests per minute per IP. Configure a shared limiter or AWS WAF if you need one limit across replicas.

## Verification

```sh
npm run check
npm run build
npm test
npx playwright install chromium
npm run test:e2e
```

The backend integration suite starts an isolated **real PostgreSQL 17** instance, exercises API CRUD, persistence, validation, CORS, database outages, and migration concurrency, then stops and removes its temporary database. Browser tests start another isolated PostgreSQL instance and real Express/Vite servers, verify the complete task flow, error recovery, mobile layout, and plain-text rendering. Tests never use the development or RDS database. Browser screenshots are written to `test-results/`.

Docker builds and live AWS connectivity require those environments; local tests do not provision AWS or verify your VPC, credentials, or RDS certificate configuration.

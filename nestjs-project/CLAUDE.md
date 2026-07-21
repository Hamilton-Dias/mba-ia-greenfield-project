# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.

## Videos Module (Fase 03)

Upload, background processing, and delivery of videos. Decisions in `docs/decisions/technical-decisions-phase-03-videos.md`, plan in `docs/phases/phase-03-videos/phase-03-videos.md`.

### Services added to `compose.yaml`

- `redis` (`redis:7-alpine`, port `6379`) — BullMQ connection.
- `minio` (`minio/minio`, ports `9000` API / `9001` console) — S3-compatible object storage, local dev implementation of the architecture's "Object Storage" container. Credentials via `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`.
- `video-worker` — standalone NestJS application (`src/worker/`), built from `Dockerfile.worker` (same base as `Dockerfile.dev` plus `ffmpeg`). Runs `NestFactory.createApplicationContext()` — **no HTTP server, no bound port**. Consumes the `video-processing` BullMQ queue and does the actual media processing.

**`ffmpeg`/`ffprobe` are only installed in the `video-worker` container, not `nestjs-api`.** Both containers share the same bind-mounted source and `.env`. Any test that exercises real ffmpeg/ffprobe (currently `src/worker/video.processor.integration-spec.ts`) must run via `docker compose exec video-worker npm test ...`, not `nestjs-api`. All other tests run from either container interchangeably.

### Object storage (`src/storage/`)

`StorageService` wraps two S3 clients against MinIO:
- **Admin client** (`STORAGE_INTERNAL_ENDPOINT`, e.g. `http://minio:9000`) — used for bucket bootstrap (`ensureBucketExists`, idempotent `HeadBucket`/`CreateBucket` on module init), multipart orchestration, `headObject`, and the worker's own reads/writes. Only this endpoint is needed by the worker process — it never issues presigned URLs.
- **Presigning client** (`STORAGE_PUBLIC_ENDPOINT`, e.g. `http://localhost:9000`), constructed lazily on first use — used only when signing a URL an external client (browser, test script) will call directly. Kept separate from the admin endpoint because a URL signed against the internal Docker-network hostname (`minio:9000`) is not resolvable outside the Compose network. Only the API process needs this env var; it's optional so the worker can omit it.

Bucket/key layout: single bucket (`STORAGE_BUCKET`, default `streamtube`), per-video prefix — `videos/{videoId}/original` and `videos/{videoId}/thumbnail.jpg`.

### Queue (`src/queue/`)

`QueueModule` registers a single BullMQ queue, `video-processing`, connected to `redis`. `VideoQueueService.enqueueProcessing(videoId)` adds a `process-video` job (`{ videoId }` payload) with `attempts: 3` and exponential backoff. The API process registers this queue as a producer; the worker registers the same queue name as a consumer with its own connection — they don't share a NestJS module tree.

### Video entity and status lifecycle (`src/videos/entities/video.entity.ts`)

`videos` table: `id` (uuid, also the public identifier — no separate slug), `channelId` (FK → `channels.id`, resolved server-side from the authenticated user's own 1:1 channel — **never accepted from the client**, closing the ownership/IDOR surface by construction), `originalFilename`, `storageKey`, `status` (enum: `draft` → `processing` → `ready` | `error`), `duration`, `thumbnailKey`, `error_message`.

- **draft → processing**: client finishes uploading directly to storage, then calls `POST /videos/:id/complete-upload`. Multipart uploads complete server-side via `CompleteMultipartUploadCommand` (success is itself the existence proof); single-PUT uploads are verified via `HeadObject` (404 `VIDEO_NOT_FOUND` on ownership mismatch/unknown id, 409 `UPLOAD_VERIFICATION_FAILED` if the object was never actually uploaded).
- **processing → ready**: `VideoProcessor` (`src/worker/video.processor.ts`, `@Processor('video-processing')`) downloads the original, runs `ffprobe` for duration and `ffmpeg` for a thumbnail (fixed 3s offset, clamped to 0s for clips shorter than 3s — `src/worker/thumbnail-offset.util.ts`), then writes `status`, `duration`, and `thumbnailKey` in one atomic update.
- **processing → error**: any ffprobe/ffmpeg/storage exception writes `status='error'` + `error_message` in one atomic update, then re-throws so BullMQ's retry/backoff governs re-attempts; after 3 attempts the video stays in `error` permanently (no automatic further retry).
- **Streaming/download gate**: `GET /videos/:id/stream` and `GET /videos/:id/download` only succeed when `status === 'ready'` — any other status (including unknown id) returns a uniform 404 `VIDEO_NOT_FOUND`, never exposing a draft/processing/broken file.

### Endpoints (`src/videos/videos.controller.ts`, prefix `videos`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/videos` | JWT required | Pre-register a draft; returns a presigned single-PUT URL (≤100MB) or a multipart handshake (`uploadId` + per-part presigned URLs, >100MB, 50MB parts) — 10GB cap enforced by DTO validation. |
| `POST` | `/videos/:id/complete-upload` | JWT required | Verifies the upload landed in storage, flips `draft` → `processing`, enqueues the processing job. |
| `GET` | `/videos/:id/stream` | Public | Presigned GET URL for inline playback (no `Content-Disposition` override), `status='ready'` only. |
| `GET` | `/videos/:id/download` | Public | Presigned GET URL with `ResponseContentDisposition: attachment; filename="<originalFilename>"`, `status='ready'` only. Same underlying object/mechanism as streaming. |

Upload bytes never pass through the API or worker process for the initiate/complete flow — the client talks to MinIO/S3 directly via the presigned URLs, matching the architecture diagram's `Rel(frontend, storage, "Streams")`.

### Test environment notes specific to this module

- `NODE_OPTIONS=--experimental-vm-modules` is set on every jest-invoking `npm` script (`test`, `test:e2e`, etc.) — required because `execa` (used by the worker to spawn `ffmpeg`/`ffprobe`) is ESM-only and is loaded via dynamic `import('execa')` from this project's CommonJS codebase; Jest's VM sandbox needs this flag to allow dynamic `import()` at all.
- Integration tests for storage/queue/worker exercise the real `minio`/`redis` services — no mocking of the transport layer, consistent with this project's existing "real DB, no ORM mocks" integration-test convention.

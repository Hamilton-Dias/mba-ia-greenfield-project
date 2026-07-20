# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 1/10 completed

### SI-03.1 — Dependencies, Configuration Namespaces, and Docker Compose
- **Status:** completed
- **Tests:** no tests
- **Observations:**
  - Chose local-dev credentials: `STORAGE_ACCESS_KEY=minioadmin`, `STORAGE_SECRET_KEY=minioadmin123`, `STORAGE_BUCKET=streamtube`, with `MINIO_ROOT_USER=minioadmin`/`MINIO_ROOT_PASSWORD=minioadmin123` matching so MinIO bootstraps with credentials the app can authenticate with. `STORAGE_INTERNAL_ENDPOINT=http://minio:9000` (Docker network), `STORAGE_PUBLIC_ENDPOINT=http://localhost:9000` (host-facing, for presigned URLs). `REDIS_HOST=redis`, `REDIS_PORT=6379`. These values should be reused as-is in later SIs (SI-03.3 Storage Module, SI-03.4 Queue Module) for consistency.
  - `npm install bullmq@^5.80.8` resolved and recorded `^5.80.9` in package.json (npm's own resolution/save behavior) — functionally equivalent, still `<6.0.0`, no action needed.
  - Did not wire `storageConfig`/`queueConfig` into `AppModule`'s `ConfigModule.forRoot({ load: [...] })` array in this SI — the plan's technical actions for SI-03.1 only call for creating the config files, updating the Joi schema, `.env`/`.env.example`, and compose.yaml. Consuming modules (`StorageModule` in SI-03.3, `QueueModule` in SI-03.4) will register/import these configs themselves when they're built, following the same pattern the plan uses for the standalone worker's own `ConfigModule.forRoot` in SI-03.7.
  - `minio/minio`'s image does include `curl`, so the healthcheck `curl -f http://localhost:9000/minio/health/live` works as specified in the plan (no need to fall back to `mc ready local`).
  - Verified end-to-end: ran `npm run start:dev` manually inside the `nestjs-api` container (it isn't auto-started — the container's default command is `tail -f /dev/null`, matching this project's existing dev workflow where the app is started via `docker compose exec` on demand) — app compiled with 0 TypeScript errors and booted cleanly with all new env vars present (no Joi validation failure), `GET /` returned 200 "Hello World!". Stopped the process afterward to leave the container in its original idle state.
  - `STORAGE_PUBLIC_ENDPOINT` is `.optional()` in the Joi schema as required — omitting it does not fail validation (reasoned directly from the schema; did not do a live break/restore test since the schema change is unambiguous).

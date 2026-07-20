---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-07-19T18:23:37-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-19T22:23:55-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-07-19T18:23:37-03:00"
  docs/phases/phase-02-auth/context.md: "2026-07-19T18:23:37-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-07-19T18:23:37-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Frontend video-upload UI, player, and progress indicators — `next-frontend/` is explicitly out of scope for this phase (backend-only challenge per the decisions doc's subprojects note); deferred to whichever future phase addresses frontend video screens. Also out of scope: video metadata editing (title/description/category/custom thumbnail), public/unlisted visibility, draft→publish flow, and the channel management panel (all Fase 04); video categories (Fase 04); the video watch page, comments, likes/dislikes, and channel subscriptions (Fases 05–06).

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/` — owns the entire phase: upload endpoints, video draft/status lifecycle, object storage integration, job queue, video worker process, and streaming/download delivery.

**Deferred subprojects:** `next-frontend/` — the video upload UI, player, and progress indicators are not part of this phase's deliverable; deferred to a future phase that addresses frontend video screens.

**Sequencing notes:** Depende de: Fase 01 — Configuração Base do Projeto (Fase 01), Fase 02 — Cadastro, Login e Gerenciamento de Conta.

**Neighbors (for boundary detection only):**

- **Fase 02 — Cadastro, Login e Gerenciamento de Conta** (prior).
- **Fase 04 — Gerenciamento de Vídeos e Canal** (next) — depends on Fase 02 e Fase 03; edição de vídeo, rascunho→publicação, painel de gerenciamento, edição de canal, página pública do canal.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Background Job Queue Technology | decided | A (BullMQ via `@nestjs/bullmq`) | `@nestjs/bullmq`, `bullmq` |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend | Upload Strategy for Files up to 10GB | decided | A (Presigned URLs, direct client → storage, multipart for large files) | — |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Object Storage Bucket/Key Organization | decided | A (Single bucket, per-video prefix) | — |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Video Draft Pre-registration and Status Lifecycle | decided | A (Single status enum column, no separate history table) | — |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Video Worker Runtime Architecture | decided | A (Standalone NestJS app via `createApplicationContext`, separate container) | — |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Media Inspection and Thumbnail Generation Tooling | decided | A (Direct `child_process`/`execa` invocation of `ffmpeg`/`ffprobe`) | `execa` |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | Unique Video URL/Identifier Strategy | decided | A (Reuse the UUID PK as the public identifier) | — |
| phase-03-videos/TD-08 | technical-decisions-phase-03-videos.md | Backend | Streaming and Download Strategy | decided | A (Presigned GET URLs, direct client → storage, shared for streaming and download) | — |
| phase-03-videos/TD-09 | technical-decisions-phase-03-videos.md | Backend | Object Storage Deployment and Endpoint Configuration | decided | A (MinIO as new `compose.yaml` service, dual-endpoint configuration) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03, phase-03-videos/TD-09 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-05 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-04 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-06 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-06 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-07 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-08 |
| Download do vídeo pelo usuário | phase-03-videos/TD-08 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** BullMQ via `@nestjs/bullmq` — the project's own `nestjs-best-practices` skill already documents this exact integration, which lowers implementation risk more than the "zero new infra" argument for pg-boss offsets. Redis is a small, well-understood addition to `compose.yaml` (one more service, like `mailpit` was in Phase 02), and BullMQ's native progress/backoff/priority primitives fit a video-processing job better than pg-boss's simpler polling model. RabbitMQ's routing flexibility is not needed for a single job type.

**Libraries:** `@nestjs/bullmq`, `bullmq`

### phase-03-videos/TD-02

**Recommendation:** Presigned URLs, direct client → storage, multipart for large files — this is the only option whose per-upload API cost is independent of file size, which is what "10GB sem impacto na performance" requires. It reuses the multipart mechanics already needed for storage regardless of choice (S3-compatible presigned multipart is the standard way to exceed the 5GB single-PUT ceiling), and it is consistent with the architecture's existing acceptance of direct frontend↔storage traffic for large binaries. TUS is a strong resumability story but adds a second upload protocol without a clear win over presigned multipart's own per-part retry/resume capability, given this project has no CDN/edge tier to justify it.

**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** Single bucket, per-video prefix — co-locating a video's original file and its thumbnail under `videos/{videoId}/...` keeps deletion/cleanup (a single prefix-list) and reasoning about "what belongs to this video" simplest, which matters because Fase 04 will add video editing/deletion flows that need to reason about a video's full artifact set. The mixed-traffic concern (Option A's con) does not yet have a driving requirement (no CDN or differentiated cache policy exists in this phase) to justify the extra structure of Options B or C.

**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** Single `status` enum column, no separate history table — it maps directly onto the phase's literal requirement (draft → automatic processing → terminal state) with the least machinery. An audit-trail table is reasonable future work once a moderation/admin UI actually needs it (candidate for Fase 04's management panel), but nothing in this phase's capabilities asks for processing history, so building it now is scope the phase does not require. An enum keeps invalid state combinations impossible by construction. **Draft→processing trigger:** because TD-02 keeps upload bytes entirely out of the API's request path (the client uploads directly to Object Storage via presigned URLs), the API has no inherent signal that the upload finished — there is no request body arriving at the API to react to. The trigger is a client call, not a storage-side event: after the client finishes the (potentially multipart) upload directly against storage, it calls a dedicated completion endpoint on the API (e.g. `POST /videos/:id/complete-upload`); the API does not rely on a storage-side webhook/bucket-notification (e.g. MinIO bucket events) to detect completion — verification is a synchronous check performed inside the completion endpoint itself. **Reconciling with TD-02's multipart requirement:** the completion endpoint's verification differs by upload path. For a **multipart** upload, the client tracks the `ETag` returned by storage for each uploaded part, then calls `POST /videos/:id/complete-upload` with the ordered list of `{partNumber, eTag}` pairs; the API performs the actual `CompleteMultipartUploadCommand` server-side via its internal-endpoint admin `S3Client` (TD-09) — a metadata-only S3 call that assembles the already-uploaded parts, with no video bytes touching the API. A successful `CompleteMultipartUploadCommand` response **is** the existence proof for this path (the command itself fails if the object cannot be assembled), so no separate `HeadObject` check is needed or performed afterward. For the **single-`PUT`** (non-multipart, small file) path, there is no completion command to call against storage — the client simply finished one presigned `PUT`, so the API's `/complete-upload` handler performs a `HeadObject` call against the TD-03 key to confirm the object actually landed before flipping `draft` → `processing` and enqueuing the TD-01 job. Both cases end the same way (status flip + enqueue) but differ in what "verify completion" means: a server-side `CompleteMultipartUploadCommand` for multipart, a `HeadObject` check for single-`PUT`. **Original filename capture:** the client supplies an `originalFilename` (or similarly-named field) as part of the `POST` payload that pre-registers the draft video row, and the API persists it on the `videos` row at draft-creation time (consumed later by TD-08's download-variant presigned GET).

**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** Standalone NestJS application via `NestFactory.createApplicationContext`, separate container — it is the only option that both matches the architecture diagram's explicit container separation and avoids re-implementing NestJS's DI wiring by hand. The extra `compose.yaml` service is a small, one-time cost (the project already added `mailpit` as a service in Phase 01/02), and isolating CPU-bound ffmpeg work from the HTTP-serving process directly addresses the "sem impacto na performance" concern that runs through this entire phase.

**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** Direct `child_process`/`execa` invocation of `ffmpeg`/`ffprobe` — with `fluent-ffmpeg` confirmed archived and its proposed successor too new to trust for a core pipeline, the most durable choice is to depend on ffmpeg/ffprobe's own CLI contract (pinned explicitly in the worker's Dockerfile) rather than on any third-party wrapper's maintenance continuing. `execa` (or plain `child_process`) adds negligible boilerplate for parsing `ffprobe`'s JSON output and constructing `ffmpeg` flag arrays, in exchange for zero wrapper-abandonment risk. **Thumbnail frame offset:** the worker captures the frame at a fixed offset of 3 seconds into the video (`ffmpeg -ss 3 -i <input> -vframes 1 <thumbnail.jpg>`), computed after `ffprobe` has already reported duration/metadata — a fixed offset avoids a data dependency on `ffprobe`'s output that a percentage-of-duration offset would require, and 3 seconds reliably skips black/fade-in frames while still landing early. **Fallback/clamp:** if the probed duration is shorter than 3 seconds, the worker captures at `0s` (the first frame) instead, so the seek never lands past end-of-stream for short clips.

**Libraries:** `execa`

### phase-03-videos/TD-07

**Recommendation:** Reuse the UUID PK as the public identifier — it satisfies the literal capability ("URL única, sem conflito") with zero added machinery, exactly matching the precedent already set by `User` and `Channel` in this codebase. Short public slugs are a legitimate product-polish upgrade, but nothing in this phase's capability bullets asks for shorter URLs specifically — introducing a second identifier column and its collision-handling code now would be building for a requirement the phase does not state.

**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** Presigned GET URLs, direct client → storage, shared for streaming and download — this is the only option consistent with the architecture diagram's explicit `Rel(frontend, storage, "Streams")` relation, and it gets `Range`-request support (essential for a scrubbable player) for free from the storage service rather than needing custom implementation. A CDN is legitimate future scaling work but isn't asked for by this phase or the current diagram. **Shared mechanism, distinguishing parameter:** streaming and download are two call sites against the same presigned `GetObjectCommand` operation, differing only in the `ResponseContentDisposition` parameter passed at signing time — the streaming URL is signed with no override (browser renders inline for the `<video>` element), while the download URL is signed with `ResponseContentDisposition: 'attachment; filename="<original-filename>"'`, instructing the browser to save the response to disk instead of playing it. **Source of `<original-filename>`:** this is the `originalFilename` value the client supplied at draft pre-registration time and the API persisted on the video row (TD-04) — the download-variant presigned GET simply reads that stored column and passes it as the `filename` in the `ResponseContentDisposition` header.

**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** MinIO as a new `compose.yaml` service, with a dual-endpoint configuration — it is the only option that keeps the project's fully-local development loop intact (new infra added as its own Compose service, exactly like `mailpit`) while actually resolving the internal-vs-public hostname mismatch: presigned URLs must be signed against a host resolvable by an external client (browser or host-side script), which is fundamentally a different network address than the one the API/worker use for their own admin calls against the Compose-internal `minio` service. The API/worker hold two configured endpoint values — `STORAGE_INTERNAL_ENDPOINT` (e.g. `http://minio:9000`, Compose service DNS name) for admin/bucket-management operations, and `STORAGE_PUBLIC_ENDPOINT` (e.g. `http://localhost:9000`, host-mapped port) used only when constructing the `S3Client` that signs presigned URLs. Single-endpoint simplicity (Option B) does not survive contact with how container networking actually works (`localhost` inside a container is not the Docker host), and skipping local MinIO entirely (Option C) solves the problem only by giving up local-only development, which is disproportionate to what this phase needs. **Which component needs which endpoint:** only the API constructs the presigning `S3Client` and needs `STORAGE_PUBLIC_ENDPOINT` — it is the sole issuer of presigned URLs, for both TD-02's upload handshake and TD-08's streaming/download URLs. The worker (TD-05) never issues a presigned URL to anyone: it is not an HTTP-facing component and performs its own direct, server-side reads/writes against storage (downloading the original file for `ffprobe`/`ffmpeg`, uploading the generated thumbnail) using only `STORAGE_INTERNAL_ENDPOINT` via an admin-style `S3Client`. Consequently `STORAGE_PUBLIC_ENDPOINT` is a required env var for the API process only; the worker's Joi validation schema only needs to declare `STORAGE_INTERNAL_ENDPOINT` (plus the shared credentials/bucket name). **Bucket/credential provisioning:** (a) *Credentials* — MinIO's root credentials are provisioned via `compose.yaml` environment variables on the `minio` service (`MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`); the API's and worker's own `S3Client` credentials are configured from those same values via `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY` env vars, so there is exactly one place (the Compose env) where the credential pair is defined and both the storage service and its consumers read from it. (b) *Bucket creation* — the bucket TD-03 designates is created via an idempotent "ensure bucket exists" check performed by the API on application bootstrap (e.g. `HeadBucket`, catch the not-found error, then `CreateBucket`), rather than a separate init container/script — this requires no extra `compose.yaml` service, runs automatically in every environment including tests, and mirrors how the app already manages its own schema via TypeORM migrations rather than an external init script.

**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Custom guards with `@nestjs/jwt` only — decision deliberately diverged from the original @nestjs/passport recommendation during implementation to keep the dependency surface smaller; social login is not on the near-term roadmap.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** JWT (Opaque was the original recommendation, but the decision deliberately diverged) — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes.

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports the relevant config factory and calls it as a plain function. _(from phase 01)_
- Database connection parameters are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_
- New entities follow the `@PrimaryGeneratedColumn('uuid')` convention already used by `User`/`Channel` — no separate public-identifier column unless a TD explicitly decides otherwise (phase-03-videos/TD-07 reaffirms this for `Video`). _(from phase 02)_
- API errors are shaped by a single custom Domain Exception Filter as `{ statusCode, error, message }` with machine-readable domain error codes — new endpoints/services should throw domain exceptions and let the filter map them to HTTP responses, not throw NestJS HTTP exceptions directly. _(from phase 02)_
- Request DTOs are validated via `class-validator` + `class-transformer` (`class-validator@^0.14.x`, `class-transformer@^0.5.x`) with the global `ValidationPipe`; DTO rules are proven via one E2E wiring test per endpoint, not per-rule unit tests. _(from phase 02)_
- `@nestjs/throttler` is the established rate-limiting mechanism, scoped per-module via `APP_GUARD` with `@SkipThrottle()` for exemptions — available as the pattern for any new endpoint (e.g., upload initiation) that needs rate limiting. _(from phase 02)_
- Auxiliary local-dev services (e.g. `mailpit` in Phase 02) are added to `compose.yaml` as their own service — the same pattern applies to new infrastructure this phase introduces (Redis for TD-01, the standalone worker container for TD-05, MinIO for TD-09). _(from phase 02)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per the rows above. |

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|-----------|--------|-----------|---------|
| Telas de upload de vídeo, player e indicadores de progresso (frontend) | deferred | `next-frontend/` is explicitly out of scope for this phase (backend-only challenge, per the decisions doc's subprojects note); deferred to whichever future phase addresses frontend video screens. | — |

## Testing Requirements

### nestjs-project

_(from `testing-guide-nestjs-project` Skill § 3 — Feature Implementation Checklist)_

| Artifact created | Required tests |
|---|---|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |

_Notes for this phase's artifact mix (not new rules — applying the table above): the video worker (TD-05) is a separate `createApplicationContext` bootstrap, not an HTTP surface — its BullMQ `@Processor` is a "Service with side-effect dep" (storage + ffmpeg) per the table, so cover it with Integration tests against a real/local adapter rather than E2E. Presigned-URL issuance (TD-02, TD-08) and the storage client are also side-effect-dependent services — same row applies. The dual-endpoint storage client (TD-09) is itself a "Service with configured lib" / "Service with side-effect dep" — its internal-vs-public endpoint selection is a real configuration contract worth an Integration test against the local MinIO service, not a mock. Race conditions called out in § 2 ("concurrent video uploads") are explicitly worth testing for this phase's upload/draft-creation path._

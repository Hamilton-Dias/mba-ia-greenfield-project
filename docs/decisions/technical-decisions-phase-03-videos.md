---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-07-19
scope_description: "Background job queue, large-file upload strategy (up to 10GB), object storage bucket/key organization, video draft lifecycle, worker runtime architecture, media inspection/thumbnailing, unique video identifiers, and streaming/download delivery for Fase 03 — Upload e Processamento de Vídeos."
---

# Technical Decisions — Fase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that owns the entire phase: upload endpoints, video draft/status lifecycle, object storage integration, job queue, video worker process, and streaming/download delivery.
- `next-frontend/` — **out of scope.** This phase is explicitly scoped as a backend-only challenge; the video upload UI, player, and progress indicators are not part of this phase's deliverable and are deferred to whichever future phase addresses frontend video screens. No open decision in this document.

---

## TD-01: Background Job Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** `docs/diagrams/software-arch.mermaid` defines a `Message Queue` container with technology explicitly marked `"TBD"` (`ContainerQueue(queue, "Message Queue", "TBD", "Enqueues video processing jobs")`), sitting between the API (`Rel(api, queue, "Publishes job")`) and the Video Worker (`Rel(queue, worker, "Delivers job")`). This is the one container-level technology genuinely left open by the architecture — object storage and the worker's media tooling are named, the queue is not. The choice determines what new infrastructure the `compose.yaml` gains, how job retries/failure are modeled, and how the API hands off video processing without blocking the upload response.

**Options:**

### Option A: BullMQ (Redis-backed) via `@nestjs/bullmq`
- Redis-backed queue library with priorities, delayed jobs, exponential backoff, per-job progress reporting, and a `@Processor`/`@InjectQueue` DI integration. Adds a `redis` service to `compose.yaml`.
- **Pros:** This repo's own `nestjs-best-practices` skill (`micro-use-queues.md`) already codifies the exact `@nestjs/bullmq` pattern (module registration, producer, `@Processor`, retry/backoff options) — the implementer has ready-made, in-repo guidance. Native job progress (`job.updateProgress()`) maps naturally to a video's transcoding progress. Mature retry/backoff semantics for a job type (ffmpeg processing) that can legitimately fail transiently (disk, memory).
- **Cons:** Adds Redis as new infrastructure purely for queuing — a service with no other current use in this project. Redis persistence/AOF configuration needs to be set deliberately or queued jobs can be lost on container restart.

### Option B: pg-boss (PostgreSQL-backed)
- Job queue implemented entirely on top of PostgreSQL using `SELECT ... FOR UPDATE SKIP LOCKED`, no additional infrastructure. Runs as a library inside any Node process with a `pg` connection.
- **Pros:** Zero new infrastructure — PostgreSQL 17 is already the project's database. ACID job state (a job and its related row updates can share a transaction). One fewer moving part in `compose.yaml` and in production ops.
- **Cons:** No equivalent in-repo best-practices guidance (the `nestjs-best-practices` skill only documents BullMQ) — the implementer has less to lean on. Database becomes both the system of record and the job broker, adding polling/locking load to the same PostgreSQL instance that serves the whole app. Weaker ecosystem for job-progress reporting and dashboards compared to BullMQ + Bull Board.

### Option C: RabbitMQ (via `amqplib` / `@nestjs/microservices` RMQ transport)
- General-purpose AMQP broker. NestJS has first-class microservice transport support for RabbitMQ.
- **Pros:** Battle-tested message broker, supports complex routing (exchanges, topics) if the project ever needs more than a single job type. NestJS microservices integration is official.
- **Cons:** Heavier operationally (its own service, exchange/queue topology to design) for a project that currently has exactly one job type (process an uploaded video). No job-level progress/backoff ergonomics as convenient as BullMQ's for this use case. Overkill relative to the single producer → single consumer shape of this phase.

**Recommendation:** **Option A (BullMQ via `@nestjs/bullmq`)** — the project's own `nestjs-best-practices` skill already documents this exact integration, which lowers implementation risk more than the "zero new infra" argument for pg-boss offsets. Redis is a small, well-understood addition to `compose.yaml` (one more service, like `mailpit` was in Phase 02), and BullMQ's native progress/backoff/priority primitives fit a video-processing job better than pg-boss's simpler polling model. RabbitMQ's routing flexibility is not needed for a single job type.

**Decision:** A (BullMQ via `@nestjs/bullmq`)

---

## TD-02: Upload Strategy for Files up to 10GB

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** `docs/project-plan.md` § Pontos de Atenção states the 10GB upload "precisa ser feito de forma que não trave o sistema" — a functional requirement, not just a nice-to-have. The C4 diagram's `Rel(api, storage, "Uploads")` describes the API's logical responsibility for getting files into storage, but does not mandate that video bytes are physically streamed through the NestJS process — the diagram is a coarse-grained container relationship, and the sibling relation `Rel(frontend, storage, "Streams", "HTTPS")` already establishes that this architecture is comfortable with the client talking to Object Storage directly for large binary transfer. A single Node.js process holding open a multi-gigabyte upload request for the duration of a slow connection (potentially tens of minutes to hours) ties up a request/socket and complicates horizontal scaling of the API tier, which is exactly the "sem impacto na performance" risk called out in the plan.

**Options:**

### Option A: Presigned URLs, direct client → Object Storage (API orchestrates only)
- The API pre-registers the video draft (see TD-04), computes the storage key (TD-03), and returns a presigned upload URL (single `PUT` for smaller files, or a presigned multipart upload — initiate + per-part presigned URLs + complete — for large files, since S3-compatible presigned `PUT` is capped at 5GB). The client uploads bytes straight to storage; the API's only involvement is issuing/completing the presigned operation and receiving a completion callback/confirmation call to flip the draft to `processing`.
- **Pros:** The API never touches video bytes — no request/socket held open for the upload duration, no risk to API throughput or memory regardless of file size. Matches the architecture's already-accepted pattern of direct frontend↔storage traffic (`Rel(frontend, storage, "Streams")`). Multipart presigned upload natively supports resuming a failed part without re-uploading the whole 10GB file. Directly satisfies "sem impacto na performance" since the API's per-upload cost is O(1) regardless of file size.
- **Cons:** Upload orchestration logic (initiate multipart, issue per-part URLs, complete/abort) is more moving parts than a single endpoint. The API loses the ability to validate file content (e.g., real MIME sniffing) before it lands in storage — validation must happen post-upload, in the worker.

### Option B: Streamed multipart/form-data through the API (no full buffering)
- Client sends a standard `multipart/form-data` upload to a NestJS endpoint; the API streams the incoming bytes directly to storage (e.g., piping the request stream into an S3 multipart upload) without ever buffering the whole file in memory.
- **Pros:** Single upload endpoint, simplest client integration (a plain HTML form or `fetch` with `FormData` — no presigned-URL handshake). The API can inspect bytes in-flight (e.g., magic-number validation) before/while forwarding them.
- **Cons:** Still ties up one API request/connection for the entire upload duration (minutes to hours for 10GB on a slow link), which is the exact bottleneck the "sem impacto na performance" requirement warns against — even without buffering in memory, the HTTP connection and its Node.js request-handling resources are occupied for the whole transfer. Harder to scale horizontally (sticky upload sessions) and to resume a failed upload without restarting from byte 0 unless a resumable protocol (Option C) is added on top.

### Option C: TUS resumable upload protocol (`tus-node-server`), proxied through the API
- Implements the open `tus` protocol (POST to create, PATCH to send chunks with `Upload-Offset`, HEAD to query offset after a failure) so uploads can pause/resume across network interruptions and browser refreshes, independent of file size.
- **Pros:** Best resumability story of the three — an interrupted 10GB upload on a flaky connection resumes from the last acknowledged byte, not from zero. Well-specified, client libraries (`tus-js-client`) handle resumption automatically.
- **Cons:** Still a server sitting in the request path for every chunk unless paired with a `tus`-to-S3 direct storage backend (adds another integration to build/operate). Introduces a new protocol and a new dependency (`tus-node-server` or equivalent) the team must learn, on top of whatever storage client is already needed. For this project's stack (S3-compatible storage, no CDN/edge tier), presigned multipart upload already delivers per-part resumability without adopting a second upload protocol.

**Recommendation:** **Option A (Presigned URLs, direct client → storage, multipart for large files)** — this is the only option whose per-upload API cost is independent of file size, which is what "10GB sem impacto na performance" requires. It reuses the multipart mechanics already needed for storage regardless of choice (S3-compatible presigned multipart is the standard way to exceed the 5GB single-PUT ceiling), and it is consistent with the architecture's existing acceptance of direct frontend↔storage traffic for large binaries. TUS is a strong resumability story but adds a second upload protocol without a clear win over presigned multipart's own per-part retry/resume capability, given this project has no CDN/edge tier to justify it.

**Decision:** A (Presigned URLs, direct client → storage, multipart for large files)

---

## TD-03: Object Storage Bucket/Key Organization

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** `docs/diagrams/software-arch.mermaid` fixes the storage *technology* as `"S3 or MinIO"` (`ContainerDb(storage, "Object Storage", "S3 or MinIO", "Video files and thumbnails")`) — that choice is out of scope for this document (MinIO is used locally in `compose.yaml`-style dev environments and exposes an S3-compatible API, so the same `@aws-sdk/client-s3` client works against either by pointing at a custom endpoint; no TD needed for that). What remains open is how objects are organized: bucket count and key/prefix layout for the two artifact types this phase produces (original video files and generated thumbnails), which must support the draft lifecycle (TD-04) and unique-identifier strategy (TD-07) without key collisions.

**Options:**

### Option A: Single bucket, per-video prefix — `videos/{videoId}/original.<ext>`, `videos/{videoId}/thumbnail.jpg`
- One bucket for the whole application; every artifact belonging to a video lives under a folder-like prefix named by the video's identifier.
- **Pros:** Trivial mental model — everything for a given video is co-located under one prefix, easy to enumerate/delete all artifacts for a video (e.g., on deletion) with a single prefix-list operation. No cross-referencing needed between a video row and multiple unrelated key roots.
- **Cons:** A single bucket mixes traffic patterns (large video reads/writes vs. small thumbnail reads) under one set of bucket-level settings (lifecycle rules, CORS, cache headers) unless those are further parameterized per-prefix.

### Option B: Single bucket, top-level type prefixes — `videos/{videoId}.<ext>`, `thumbnails/{videoId}.jpg`
- One bucket, but videos and thumbnails live under separate top-level prefixes rather than nested per-video folders.
- **Pros:** Clean separation between the two artifact types for prefix-scoped policies (e.g., a CDN cache-control rule for `thumbnails/*` that would be wrong for `videos/*`). Slightly shorter keys.
- **Cons:** Deleting "everything for video X" now requires two separate key lookups (one per prefix) instead of one prefix-list. No structural difference in collision-safety versus Option A — both rely entirely on `{videoId}` being unique (TD-07).

### Option C: Two buckets — one for videos, one for thumbnails
- Physically separate buckets (`streamtube-videos`, `streamtube-thumbnails`) instead of prefixes within one bucket.
- **Pros:** Strongest isolation — bucket-level policies (lifecycle, versioning, public-read for thumbnails vs. strictly-private for videos) never risk leaking across artifact types by prefix-matching mistakes.
- **Cons:** Doubles the bucket provisioning/configuration surface for a project at this scale (one dev MinIO instance, one production target) where prefix-level policies (Option B) already achieve the same isolation without the extra bucket. Two buckets is meaningful at large multi-tenant scale, not clearly justified here yet.

**Recommendation:** **Option A (single bucket, per-video prefix)** — co-locating a video's original file and its thumbnail under `videos/{videoId}/...` keeps deletion/cleanup (a single prefix-list) and reasoning about "what belongs to this video" simplest, which matters because Fase 04 will add video editing/deletion flows that need to reason about a video's full artifact set. The mixed-traffic concern (Option A's con) does not yet have a driving requirement (no CDN or differentiated cache policy exists in this phase) to justify the extra structure of Options B or C.

**Decision:** A (single bucket, per-video prefix)

---

## TD-04: Video Draft Pre-registration and Status Lifecycle

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The phase requires a video row to exist as soon as an upload begins (`draft`), transition once bytes finish arriving and the worker starts inspecting them, and land in either a success or failure state — with `docs/project-plan.md`'s "Fluxo de rascunho → publicação" (Fase 04) implying `videos` is a long-lived entity that outlives this phase. This decision defines what state the `videos` table tracks and how the worker reports success/failure back, given TD-01's queue and TD-05's worker are the ones performing the actual processing. **What triggers the `draft` → `processing` transition specifically:** because TD-02 keeps upload bytes entirely out of the API's request path (the client uploads directly to Object Storage via presigned URLs), the API has no inherent signal that the upload finished — there is no request body arriving at the API to react to. The trigger is a client call, not a storage-side event: after the client finishes the (potentially multipart) upload directly against storage, it calls a dedicated completion endpoint on the API (e.g. `POST /videos/:id/complete-upload`). That endpoint verifies the object actually exists in storage (a `HeadObject`-equivalent call against the key computed in TD-03) before flipping the row from `draft` to `processing` and enqueuing the TD-01 job — the API does not rely on a storage-side webhook/bucket-notification (e.g. MinIO bucket events) to detect completion; verification is a synchronous check performed inside the completion endpoint itself.

**Options:**

### Option A: Single `status` enum column on `videos` (`draft` → `processing` → `ready` | `error`)
- One `status` column (backed by a Postgres enum or check constraint) on the `videos` entity. The API sets `draft` at pre-registration (before upload starts); the client then calls `POST /videos/:id/complete-upload` once its direct-to-storage upload finishes, the API confirms the object exists in storage (`HeadObject`-equivalent), and only then sets `processing` and enqueues the job; the worker updates the row to `ready` (with extracted metadata) or `error` (with a stored error reason) when the job finishes.
- **Pros:** Simplest possible model — one column, directly queryable (`WHERE status = 'ready'` for anything that must only show processed videos, e.g. Fase 04/05's public listings). Matches the exact wording of the phase's capability bullets (draft, then automatic processing, implicitly to a terminal state). Failure handling is just: catch the worker's error, write `error` + a message column, no separate infrastructure.
- **Cons:** No history — if a video is retried after `error`, the previous failure reason is overwritten rather than preserved unless a separate `error_message` column (not a table) also gets overwritten with each attempt. No visibility into *why* a video is still `processing` for a long time (stuck vs. genuinely slow) without also consulting the job queue directly.

### Option B: Status column + append-only `video_processing_events` history table
- Same `status` enum as Option A, plus a separate table logging every transition (`videoId`, `fromStatus`, `toStatus`, `message`, `occurredAt`), giving a full audit trail.
- **Pros:** Full history for debugging ("this video failed twice before succeeding on retry") and potential future UI (a processing timeline). Decouples "current state" (fast to query) from "history" (append-only, no update contention).
- **Cons:** A second table and its writes for a capability that only asks for a draft → ready/error lifecycle, not an audit UI — this is speculative scope the phase's bullets don't request. Adds a write on every transition with no consumer in this phase or the next.

### Option C: Boolean flags instead of an enum (`is_uploaded`, `is_processed`, `has_error`)
- Track lifecycle as independent boolean columns rather than one enum.
- **Pros:** Avoids enum migrations if new states are added later (just add another boolean).
- **Cons:** Boolean combinations can represent invalid states (e.g., `has_error = true` and `is_processed = true` simultaneously) unless enforced by application logic or constraints — an enum makes invalid states structurally unrepresentable. Harder to reason about "what is the video's current status" from three independent columns than from one value.

**Recommendation:** **Option A (single status enum, no separate history table)** — it maps directly onto the phase's literal requirement (draft → automatic processing → terminal state) with the least machinery. An audit-trail table (Option B) is reasonable future work once a moderation/admin UI actually needs it (candidate for Fase 04's management panel), but nothing in this phase's capabilities asks for processing history, so building it now is scope the phase does not require. An enum (vs. Option C's booleans) keeps invalid state combinations impossible by construction.

**Decision:** A (single status enum, no separate history table)

---

## TD-05: Video Worker Runtime Architecture

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** `docs/diagrams/software-arch.mermaid` models the `Video Worker` as its own container, separate from the `API` container, consuming jobs delivered by the queue (`Rel(queue, worker, "Delivers job")`) and updating storage/DB directly (`Rel(worker, storage, "Reads/Saves")`, `Rel(worker, db, "Updates")`). This decision is about how that container is actually implemented in the NestJS codebase — whether it is a truly separate deployable process or logic living inside the same API application — given ffmpeg-based video processing is CPU-bound and long-running, which is exactly the kind of work that should not compete with HTTP request handling in the same event loop.

**Options:**

### Option A: Standalone NestJS application (`NestFactory.createApplicationContext`), separate process/container
- A dedicated entry point (e.g., `src/worker.ts` / a `WorkerModule`) bootstrapped via `NestFactory.createApplicationContext()` instead of `NestFactory.create()` — no HTTP server, just DI context, registers the BullMQ `@Processor`. Runs as its own `compose.yaml` service/Dockerfile command, matching the diagram's separate `Video Worker` container.
- **Pros:** Matches the architecture diagram literally — a separate container that can be scaled, restarted, and resource-limited (CPU/memory) independently from the API. CPU-heavy ffmpeg work never competes with request-handling latency in the API's event loop. Still gets full NestJS DI, so it can reuse the same `VideosModule`/entities/config as the API without duplicating code — only the bootstrap file differs.
- **Cons:** A second Docker service/build target to define and operate (its own `Dockerfile`/command in `compose.yaml`), and a second process to monitor in production.

### Option B: In-process worker — `@Processor` registered inside the main API application
- The same NestJS application that serves HTTP requests also registers the BullMQ processor, so one process does both jobs.
- **Pros:** Zero extra deployment artifact — nothing new in `compose.yaml`, simplest possible setup for a project at this stage.
- **Cons:** Contradicts the architecture diagram's explicit separate `Video Worker` container. A long-running ffmpeg job shares the same Node.js process (and, depending on how ffmpeg is invoked, the same event loop) as HTTP request handling — a burst of video processing can degrade API latency for unrelated requests, which is the operational risk the diagram's separation was presumably modeling.

### Option C: Non-NestJS plain Node.js worker script
- A bare Node.js script using BullMQ's `Worker` class directly, without NestJS's DI container at all.
- **Pros:** Minimal runtime overhead — no NestJS bootstrap cost for a process that only needs a job consumer loop.
- **Cons:** Cannot reuse NestJS-managed providers (`TypeOrmModule` repositories, `ConfigService`, the storage client provider) without re-wiring them by hand outside DI — duplicates wiring that Option A gets for free via `createApplicationContext()`. Diverges from the project's established all-NestJS architecture for no clear benefit over Option A.

**Recommendation:** **Option A (standalone NestJS application via `createApplicationContext`, separate container)** — it is the only option that both matches the architecture diagram's explicit container separation and avoids re-implementing NestJS's DI wiring by hand. The extra `compose.yaml` service is a small, one-time cost (the project already added `mailpit` as a service in Phase 01/02), and isolating CPU-bound ffmpeg work from the HTTP-serving process directly addresses the "sem impacto na performance" concern that runs through this entire phase.

**Decision:** A (standalone NestJS application via `createApplicationContext`, separate container)

---

## TD-06: Media Inspection and Thumbnail Generation Tooling

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** `docs/diagrams/software-arch.mermaid` already names the worker's core technology as `FFmpeg` (`Container(worker, "Video Worker", "FFmpeg", "Processes videos in background")`) — so *whether* to use ffmpeg/ffprobe is not open. What is open is how the worker invokes it from Node.js. The historically dominant wrapper, `fluent-ffmpeg`, was archived by its maintainer and stopped being published as of mid-2025 — it no longer works reliably with recent ffmpeg versions, so it must not be the default choice for a greenfield 2026 project even though most existing tutorials still reference it.

**Frame-selection rule for the thumbnail:** the worker captures the frame at a fixed offset of **3 seconds** into the video (`ffmpeg -ss 3 -i <input> -vframes 1 <thumbnail.jpg>`), computed after `ffprobe` has already reported duration/metadata. A fixed offset is chosen over a percentage-of-duration offset because it is a single hardcoded seek value with no dependency ordering on `ffprobe`'s output (percentage-based seeking requires duration to already be known before the `ffmpeg` seek command can be constructed, adding a data dependency for no real benefit at this phase's scale), and 3 seconds reliably skips the black/fade-in frames many videos open with while still landing early enough to be representative. **Fallback/clamp:** if the probed duration is shorter than 3 seconds, the worker captures at `0s` (the first frame) instead, so the seek never lands past end-of-stream for short clips.

**Options:**

### Option A: Direct `child_process` invocation of the system `ffmpeg`/`ffprobe` binaries (e.g. via `execa`)
- Spawn `ffprobe -print_format json -show_format -show_streams <file>` and parse its JSON stdout for duration/metadata; spawn `ffmpeg -ss <time> -i <file> -vframes 1 <thumbnail>` for thumbnail extraction. The binaries are installed explicitly in the worker's Dockerfile (pinned version), not bundled via an npm wrapper.
- **Pros:** No dependency on any wrapper library's maintenance status — `ffmpeg`/`ffprobe`'s own CLI and JSON output are the actual long-term-stable contract. `execa` (or plain `child_process.spawn`) is a thin, actively maintained process-spawning utility, not a video-specific abstraction that can go stale. Full control over exact CLI flags, matching whatever ffmpeg version is pinned in the worker image.
- **Cons:** Slightly more boilerplate than a fluent builder API — flags are constructed as string arrays rather than chained method calls, and `ffprobe`'s JSON shape must be parsed/typed by hand (or with a small local type).

### Option B: `fluent-ffmpeg` (the historically dominant wrapper)
- Chainable builder API (`.input().outputOptions().on('end', ...)`) wrapping `child_process` calls to `ffmpeg`/`ffprobe`.
- **Pros:** Familiar API used in the majority of existing tutorials/StackOverflow answers; nicer chainable syntax than raw flag arrays.
- **Cons:** The package was archived and stopped receiving updates in 2025 (author's own notice: "Package no longer supported"), and it no longer works correctly against recent ffmpeg releases — adopting it new in a 2026 greenfield project means starting on a dependency with no path to fixes for compatibility breaks introduced by future ffmpeg updates.

### Option C: `mediaforge` (new TypeScript fluent-ffmpeg successor)
- A 2026-era, fully-typed TypeScript wrapper explicitly positioned as `fluent-ffmpeg`'s replacement, with a similar fluent builder API and no native bindings (still shells out to the system ffmpeg binary).
- **Pros:** Modern TypeScript-first API, deliberately designed to close the gaps that killed `fluent-ffmpeg` (typed options, works against current ffmpeg releases).
- **Cons:** Very young project (first public coverage in March 2026) with no established track record, adoption metrics, or multi-year maintenance history to evaluate — adopting it now carries the same "will this still be maintained in two years" risk that just materialized for `fluent-ffmpeg`, for a core piece of this phase's processing pipeline.

**Recommendation:** **Option A (direct `child_process`/`execa` invocation of `ffmpeg`/`ffprobe`)** — with `fluent-ffmpeg` confirmed archived and its proposed successor too new to trust for a core pipeline, the most durable choice is to depend on ffmpeg/ffprobe's own CLI contract (pinned explicitly in the worker's Dockerfile) rather than on any third-party wrapper's maintenance continuing. `execa` (or plain `child_process`) adds negligible boilerplate for parsing `ffprobe`'s JSON output and constructing `ffmpeg` flag arrays, in exchange for zero wrapper-abandonment risk.

**Decision:** A (direct `child_process`/`execa` invocation of `ffmpeg`/`ffprobe`)

---

## TD-07: Unique Video URL/Identifier Strategy

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Every existing entity (`User`, `Channel`) uses `@PrimaryGeneratedColumn('uuid')` as its internal primary key, and neither currently exposes a different public-facing identifier — the UUID PK *is* the public identifier where one is needed. This phase must decide whether `videos` follows that exact precedent, or introduces a distinct public identifier decoupled from the internal PK (the classic "short YouTube-style ID" pattern), given a video's URL is the phase's explicit deliverable ("URL única, sem conflito").

**Options:**

### Option A: Reuse the UUID primary key directly as the public video identifier
- `videos.id` is a `@PrimaryGeneratedColumn('uuid')`, exactly like `User`/`Channel`, and the public video URL is `/videos/{uuid}`. No separate public-identifier column.
- **Pros:** Zero additional implementation — no collision-check/retry logic, no extra unique-indexed column. UUIDv4's collision probability already makes "sem conflito" trivially true. Consistent with the exact convention already established by `User` and `Channel` in this codebase — a new contributor reading `videos.entity.ts` sees the same pattern as every other entity.
- **Cons:** UUIDs are long (36 characters) and not visually "clean" in a shared URL, compared to YouTube-style short IDs — a cosmetic, not functional, downside.

### Option B: Separate short public slug (e.g. `nanoid`), decoupled from the internal UUID PK
- `videos.id` remains the internal UUID PK (used for FKs, joins), but a second unique-indexed column (`publicId`, an 8–11 character `nanoid`) is generated at draft creation and used in the public URL (`/videos/{publicId}`) instead of the PK.
- **Pros:** Short, YouTube-like URLs — closer to the product's stated identity as "uma plataforma de compartilhamento de vídeos" modeled after YouTube. Decouples the public surface from the internal PK, leaving room to change the public identifier scheme later (or support vanity URLs) without touching foreign keys anywhere else in the schema.
- **Cons:** Adds a uniqueness check + regenerate-on-collision loop at draft-creation time (small but real extra code, plus an additional unique index) for a benefit that is purely cosmetic (URL length/aesthetics) — the literal requirement ("URL única, sem conflito") does not itself demand short URLs, just non-conflicting ones, which Option A already satisfies with less code.

**Recommendation:** **Option A (reuse the UUID PK as the public identifier)** — it satisfies the literal capability ("URL única, sem conflito") with zero added machinery, exactly matching the precedent already set by `User` and `Channel` in this codebase. Short public slugs (Option B) are a legitimate product-polish upgrade, but nothing in this phase's capability bullets asks for shorter URLs specifically — introducing a second identifier column and its collision-handling code now would be building for a requirement the phase does not state.

**Decision:** A (reuse the UUID PK as the public identifier)

---

## TD-08: Streaming and Download Strategy

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** `docs/diagrams/software-arch.mermaid` explicitly states `Rel(frontend, storage, "Streams", "HTTPS")` — the architecture has already committed to video playback going directly from the client to Object Storage, not proxied through the API. This is a stronger constraint than a mere suggestion: it is drawn as a first-class relation in the C4 diagram, on equal footing with `Rel(frontend, api, "Calls", "REST")`. This decision covers both playback (streaming, with seek support) and the explicit "download the video" capability, since both ultimately need the same mechanism — controlled read access to an object that must support partial/range reads for a scrubbable player. "Shared mechanism" here means one underlying operation (a presigned `GetObjectCommand`), not one literal URL: streaming and download are two distinct call sites against that same operation, differing only in the `ResponseContentDisposition` parameter passed at signing time — the streaming URL is signed with no `ResponseContentDisposition` override (so the browser renders the response inline, letting the `<video>` element play it), while the download URL is signed with `ResponseContentDisposition: 'attachment; filename="<original-filename>"'`, which instructs the browser to save the response to disk instead of playing it. This is a parameter on the presigned GET call itself, not a different download mechanism or a separate endpoint type.

**Options:**

### Option A: Presigned GET URLs (direct client → Object Storage), reused for both streaming and download
- The API issues a short-lived presigned `GET` URL for a video's storage key. The `<video>` element's `src` (or a player library) is pointed straight at that URL for playback — S3-compatible storage natively serves `Range` requests, so seeking/scrubbing works without any custom logic. The download button requests the same kind of presigned URL, with `response-content-disposition=attachment; filename="..."` set so the browser downloads instead of playing inline.
- **Pros:** Directly implements the architecture's own `Rel(frontend, storage, "Streams")` relation — no divergence from the committed design. Range-request support (required for a scrubbable player and for resumable downloads) comes for free from the storage service; nothing custom to implement or maintain. The API's per-playback/per-download cost is O(1) (issue a URL) regardless of video size or how much of it is watched — consistent with the "sem impacto na performance" theme running through this phase. One mechanism serves both capabilities, differing only in a query parameter.
- **Cons:** Presigned URL expiry must be generous enough to cover a full viewing session (including seeks late in a long video) or refreshed transparently by the frontend — a tuning concern, not a structural one. The API cannot enforce per-request authorization *after* issuing a URL (e.g., mid-stream) — acceptable here since unlisted/public visibility is a Fase 04 concern layered on top of *issuing* the URL, not on the byte transfer itself.

### Option B: API byte-proxy — NestJS streams bytes from storage to the client
- A controller endpoint reads the object from storage and pipes it to the HTTP response, manually parsing and honoring `Range` request headers to support seeking.
- **Pros:** Every request passes through the API, so access-control checks (e.g., unlisted-video link gating) can be enforced per-byte-range request, not just at URL-issuance time. No presigned-URL expiry tuning to get right.
- **Cons:** Directly contradicts the architecture's `Rel(frontend, storage, "Streams")` relation — the diagram was drawn with direct client↔storage traffic in mind, not an API proxy. Every second of every view/download now occupies an API request/connection and consumes API-tier bandwidth, which is the same "ties up the process" concern that disqualified streamed uploads in TD-02, now applied to the read path. `Range` handling has to be implemented and tested by hand instead of relying on the storage service's native support.

### Option C: CDN in front of Object Storage (e.g., signed CDN URLs)
- A CDN (CloudFront, or a MinIO+edge-cache layer) sits between clients and storage, with the API issuing signed CDN URLs instead of presigned storage URLs directly.
- **Pros:** Offloads repeated-view bandwidth from the origin storage entirely; adds edge caching for popular videos.
- **Cons:** Introduces an entire new infrastructure component (CDN configuration, signed-URL/cookie scheme, cache invalidation) that nothing in this phase's capabilities or the architecture diagram calls for — the diagram models a direct `frontend → storage` relation, not a CDN tier. Premature at this stage; worth revisiting once real traffic/scale data exists, not as part of Fase 03's initial delivery.

**Recommendation:** **Option A (presigned GET URLs, direct client → storage, shared for streaming and download)** — this is the only option consistent with the architecture diagram's explicit `Rel(frontend, storage, "Streams")` relation, and it gets `Range`-request support (essential for a scrubbable player) for free from the storage service rather than needing custom implementation. A CDN (Option C) is legitimate future scaling work but isn't asked for by this phase or the current diagram.

**Decision:** A (presigned GET URLs, direct client → storage, shared for streaming and download)

---

## TD-09: Object Storage Deployment and Endpoint Configuration

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", and underpins TD-02's and TD-08's presigned-URL mechanics (upload and streaming/download both depend on object storage actually being reachable and correctly signed).

**Context:** `docs/diagrams/software-arch.mermaid` already fixes *which* storage technology to use — `ContainerDb(storage, "Object Storage", "S3 or MinIO", "Video files and thumbnails")` — so the choice of an S3-compatible API, with MinIO as the local-dev implementation, is not open and is not re-litigated here (this is the same "no TD needed" reasoning TD-03 already applies to the technology pick). What is genuinely undecided is *how that storage is deployed and configured* for this project: nothing in `compose.yaml` currently provisions any object storage service, and TD-02/TD-08's presigned-URL mechanics only work end-to-end if the API/worker can reach storage AND the URLs they hand to an external client (browser, or a host-side test script) are resolvable outside the Docker network. Concretely: the API and worker containers reach storage over the Compose internal network (e.g. a service named `minio`, reachable as `http://minio:9000`), but a presigned URL signed against that internal hostname embeds `minio:9000` as part of its signature — a browser or host-side process cannot resolve `minio` at all, and simply rewriting the host in the URL after the fact invalidates the signature (S3-style signing binds the host into the signed payload). Since TD-02 (upload) and TD-08 (streaming/download) both depend on presigned URLs being usable by an external actor, this must be resolved for either TD to be implementable as described — this is exactly `IC-1`'s finding.

**Options:**

### Option A: MinIO as a new `compose.yaml` service, with dual-endpoint configuration (internal endpoint for admin calls, public endpoint for presigned-URL signing)
- Add a `minio` service to `nestjs-project/compose.yaml` (image + published ports, e.g. `9000` for the S3 API and `9001` for the console), mirroring exactly how `mailpit` was added as a new service in Phase 02. The API/worker hold **two** configured endpoint values: `STORAGE_INTERNAL_ENDPOINT` (e.g. `http://minio:9000`, the Compose service DNS name) used for admin/bucket-management operations (create bucket, `HeadObject` checks, etc.) issued from inside the containers, and `STORAGE_PUBLIC_ENDPOINT` (e.g. `http://localhost:9000`, the host-mapped port) used **only** when constructing the `S3Client` instance that signs presigned URLs — so the signature is computed against the externally-reachable host:port and is resolvable by a browser or a host-side script. In practice this means two `S3Client` instances (or one client whose endpoint is swapped per-call), both pointed at the same underlying MinIO server, differing only in which hostname is baked into their requests/signatures.
- **Pros:** Directly resolves `IC-1` — presigned URLs are always signed against a host the external client can actually resolve, while internal admin traffic still uses the fast, reliable Compose-internal DNS name. Matches the project's own established convention for adding new local-dev infrastructure (the same `compose.yaml`-service pattern already used for `mailpit` in Phase 02, and planned for Redis/TD-01 and the worker container/TD-05). This is also the documented community fix for this exact "wrong hostname in MinIO presigned URL" problem (see MinIO's own issue trackers, e.g. minio/minio#7209 and #10222, which describe precisely this internal-vs-public host mismatch and converge on a distinct public-facing endpoint for signing).
- **Cons:** Two endpoint environment variables (and two client configurations) instead of one — a small but real increase in configuration surface, and the public endpoint value must be kept in sync with whatever port `compose.yaml` actually publishes.

### Option B: MinIO as a new `compose.yaml` service, single publicly-reachable endpoint used everywhere
- Same new `minio` Compose service as Option A, but only one endpoint value is configured and used for both admin operations and presigned-URL signing (e.g. `http://localhost:9000` everywhere, including inside the API/worker containers).
- **Pros:** Simplest possible configuration — one endpoint value, no risk of the two envs drifting out of sync.
- **Cons:** Breaks for the API/worker's own admin calls: from inside a container, `localhost` resolves to the container itself, not to the Docker host or to the `minio` service — a container cannot reach another container's published port through `localhost`, regardless of host OS. Making this work would require switching to Docker Desktop's `host.docker.internal` alias or to host networking, neither of which the project's existing services (`db`, `mailpit`) rely on today, and `host.docker.internal` support/behavior is not uniform across platforms (available by default on Docker Desktop for Windows/Mac; requires an explicit `extra_hosts: host-gateway` entry on native Linux Docker Engine) — a portability risk for contributors on different OSes. This option only avoids the dual-endpoint problem by trading it for a less portable, less consistent networking setup.

### Option C: Skip local MinIO container; point every environment (including local dev) at a real external S3-compatible provider
- No `minio` service in `compose.yaml`; a single `STORAGE_ENDPOINT` env var always points at a real hosted S3-compatible bucket (AWS S3 or a managed alternative), even for local development.
- **Pros:** No dual-endpoint problem at all — the same public endpoint is genuinely reachable by every consumer (API, worker, and external clients) because it is a real internet-facing service, not a Docker-internal alias.
- **Cons:** Breaks the project's established fully-local `docker compose up` development loop (the same loop `db` and `mailpit` support today) — running tests or developing offline now requires live internet access and a provisioned external account/credentials just to exercise upload/storage code paths. Introduces real (if small) cost and an external dependency for local development, which nothing in this phase's requirements calls for.

**Recommendation:** **Option A (MinIO as a new `compose.yaml` service, with a dual-endpoint configuration)** — it is the only option that keeps the project's fully-local development loop intact (new infra added as its own Compose service, exactly like `mailpit`) while actually resolving `IC-1`: presigned URLs must be signed against a host resolvable by an external client, and that is fundamentally a different network address than the one the API/worker use for their own admin calls against the Compose-internal `minio` service. Option B's single-endpoint simplicity does not survive contact with how container networking actually works (`localhost` inside a container is not the Docker host), and Option C solves the networking problem only by giving up local-only development entirely, which is disproportionate to what this phase needs.

**Decision:** A (MinIO as a new `compose.yaml` service, with a dual-endpoint configuration — internal endpoint for admin operations, public endpoint for presigned-URL signing)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Background Job Queue Technology | BullMQ via `@nestjs/bullmq` | A (BullMQ via `@nestjs/bullmq`) |
| TD-02 | Backend | Upload Strategy for Files up to 10GB | Presigned URLs, direct client → storage (multipart for large files) | A (Presigned URLs, direct client → storage) |
| TD-03 | Backend | Object Storage Bucket/Key Organization | Single bucket, per-video prefix (`videos/{videoId}/...`) | A (Single bucket, per-video prefix) |
| TD-04 | Backend | Video Draft Pre-registration and Status Lifecycle | Single `status` enum column, no separate history table | A (Single status enum column) |
| TD-05 | Backend | Video Worker Runtime Architecture | Standalone NestJS app (`createApplicationContext`), separate container | A (Standalone NestJS app, separate container) |
| TD-06 | Backend | Media Inspection and Thumbnail Generation Tooling | Direct `child_process`/`execa` invocation of `ffmpeg`/`ffprobe` | A (Direct `child_process`/`execa`) |
| TD-07 | Backend | Unique Video URL/Identifier Strategy | Reuse the UUID primary key as the public identifier | A (Reuse the UUID PK as the public identifier) |
| TD-08 | Backend | Streaming and Download Strategy | Presigned GET URLs, direct client → storage, shared for streaming and download | A (Presigned GET URLs, direct client → storage) |
| TD-09 | Backend | Object Storage Deployment and Endpoint Configuration | MinIO as a new `compose.yaml` service, dual-endpoint configuration (internal for admin, public for presigned signing) | A (MinIO as new `compose.yaml` service, dual-endpoint configuration) |

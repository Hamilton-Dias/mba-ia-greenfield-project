---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-19T23:00:28-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-19T22:59:24-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-19T22:41:52-03:00"
  docs/project-plan.md: "2026-07-19T18:23:37-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-07-19T18:23:37-03:00"
  docs/phases/phase-02-auth/context.md: "2026-07-19T18:23:37-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-07-19T18:23:37-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver end-to-end video ingestion — presigned direct-to-storage upload (single-PUT or multipart) up to 10GB, automatic draft pre-registration, background processing via a standalone worker (duration/metadata extraction and thumbnail generation), a unique per-video URL, and presigned streaming/download delivery — establishing the object storage and background-job foundation all subsequent video-management phases build on.

---

## Step Implementations

### SI-03.1 — Dependencies, Configuration Namespaces, and Docker Compose

**Description:** Install all Phase 03 production dependencies, create the `storage` and `queue` config namespaces following the `registerAs` pattern from Phase 01, extend the Joi validation schema, and add the Redis and MinIO services to Docker Compose.

**Technical actions:**

- Install production dependencies in nestjs-project: `@nestjs/bullmq@^11.0.4`, `bullmq@^5.80.8`, `execa@^10.0.0`, `@aws-sdk/client-s3@^3.1090.0`, `@aws-sdk/s3-request-presigner@^3.1090.0`
- Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading `STORAGE_INTERNAL_ENDPOINT` (string, required — e.g. `http://minio:9000`, per `phase-03-videos/TD-09`), `STORAGE_PUBLIC_ENDPOINT` (string, optional — e.g. `http://localhost:9000`; only the API process ever needs it, per TD-09's "only the API constructs the presigning `S3Client`" clause), `STORAGE_ACCESS_KEY` (string, required), `STORAGE_SECRET_KEY` (string, required), `STORAGE_BUCKET` (string, default `'streamtube'`)
- Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading `REDIS_HOST` (string, default `'redis'`), `REDIS_PORT` (number, default `6379`)
- Update `src/config/env.validation.ts` — add `STORAGE_INTERNAL_ENDPOINT` (required, uri), `STORAGE_PUBLIC_ENDPOINT` (optional, uri — deliberately not `.required()`, so the worker process's environment can omit it per TD-09), `STORAGE_ACCESS_KEY` (required), `STORAGE_SECRET_KEY` (required), `STORAGE_BUCKET` (default), `REDIS_HOST` (default), `REDIS_PORT` (default) to the Joi schema. Update `.env.example` with Docker Compose-compatible defaults
- Add `redis` and `minio` services to `nestjs-project/compose.yaml` — `redis`: image `redis:7-alpine`, port `6379`, healthcheck `redis-cli ping`; `minio`: image `minio/minio`, command `server /data --console-address ":9001"`, ports `9000:9000` (API) and `9001:9001` (console), environment `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`, healthcheck against `mc ready local` or a `curl` on `/minio/health/live`; `nestjs-api` gains `depends_on: redis (service_started), minio (service_healthy)`

**Dependencies:** None

**Acceptance criteria:**

- Application starts without errors when all new environment variables are provided — existing E2E test (`GET /` returns 200) still passes
- Starting the application without `STORAGE_INTERNAL_ENDPOINT` causes a Joi validation error at bootstrap — the app does not start
- Starting the application without `STORAGE_PUBLIC_ENDPOINT` does NOT cause a Joi validation error — the field is optional
- `redis` is reachable via `redis-cli ping` and `minio` is reachable at `localhost:9001` (console) inside the Docker network

---

### SI-03.2 — Video Entity and Migration

**Description:** Create the `Video` entity carrying the draft→processing→terminal status lifecycle, its ownership FK to `Channel`, and the fields the worker writes on completion. Create the `VideoNotFoundException` domain exception (reused by every video-facing endpoint for both true-not-found and status-gated "not visible" cases). Generate the migration.

**Technical actions:**

- Create `src/videos/entities/video.entity.ts` — `@Entity('videos')` with columns: `id` (uuid PK generated), `channelId` (uuid, FK → channels.id, not null — per `phase-03-videos/TD-04`'s ownership clause), `originalFilename` (varchar, not null — per TD-04), `storageKey` (varchar, not null — the TD-03 object key of the original file, `videos/{id}/original`), `status` (enum: `'draft'`, `'processing'`, `'ready'`, `'error'`; not null, default `'draft'` — the single status column per TD-04), `duration` (real, nullable — ffprobe-reported seconds, per TD-04), `thumbnailKey` (varchar, nullable — the TD-03 object key `videos/{videoId}/thumbnail.jpg`, per TD-04/TD-06), `error_message` (text, nullable — populated only in `status='error'`, per TD-04), `created_at` (CreateDateColumn), `updated_at` (UpdateDateColumn). Define `@ManyToOne(() => Channel)` with `@JoinColumn({ name: 'channelId' })` and an index on `channelId`
- Create `src/videos/exceptions/video-not-found.exception.ts` — `VideoNotFoundException extends DomainException` with `errorCode: 'VIDEO_NOT_FOUND'`, `httpStatus: 404` — used uniformly for a truly-missing video, an ownership mismatch on `complete-upload`, and a non-`ready` status on stream/download (per TD-04's ownership clause and TD-08's status-gating clause, both of which collapse to a single "not found" outcome by design)
- Generate migration via `npm run migration:generate -- src/database/migrations/CreateVideos` and review the generated SQL for correct columns, the `channelId` FK constraint, the status enum type, and the index on `channelId`
- Create `src/videos/videos.module.ts` — `VideosModule` with `TypeOrmModule.forFeature([Video])` in imports, exports `TypeOrmModule` so other modules can access the repository (extended by SI-03.5/SI-03.6 with controller, service, and cross-module imports)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | `channelId` FK constraint, `status` enum accepts only the four values, `status` defaults to `'draft'`, `duration`/`thumbnailKey`/`error_message` nullable, timestamps auto-populated |
| `src/videos/exceptions/video-not-found.exception.spec.ts` | Unit | Constructs with `errorCode: 'VIDEO_NOT_FOUND'` and `httpStatus: 404` |
| `src/videos/videos.module.spec.ts` | Unit | Module compiles with `TypeOrmModule.forFeature([Video])` wiring |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` creates the `videos` table with all columns, the `channelId` foreign key, and the status enum constraint
- Inserting a video with `channelId` pointing to a non-existent channel fails with a foreign key violation
- Inserting a video with a `status` value outside `draft`/`processing`/`ready`/`error` fails with an enum constraint violation
- A newly created video has `status = 'draft'` by default, with `duration`, `thumbnailKey`, and `error_message` all `null`

---

### SI-03.3 — Storage Module (Dual S3 Clients, Presigned Operations, Bucket Bootstrap)

**Description:** Create the storage abstraction wrapping two S3-compatible clients against MinIO — an admin client bound to `STORAGE_INTERNAL_ENDPOINT` for server-side operations, and a lazily-constructed presigning client bound to `STORAGE_PUBLIC_ENDPOINT` for anything handed to an external client. Bootstrap the bucket idempotently on application start.

**Technical actions:**

1. Create `src/storage/storage.module.ts` — `StorageModule` providing a single admin `S3Client` (constructed eagerly at module init, `endpoint: storageConfig.internalEndpoint`, `forcePathStyle: true`, credentials from `storageConfig`) injected via a custom provider token; exports `StorageService`
2. Create `src/storage/storage.service.ts` — `onModuleInit()` calls `ensureBucketExists()`: `HeadBucketCommand` against the admin client, catch not-found (`err.name === 'NotFound'` or `httpStatusCode === 404`), then `CreateBucketCommand` (per `phase-03-videos/TD-09`'s idempotent bootstrap)
3. Implement multipart methods on `StorageService`: `createMultipartUpload(key)` (`CreateMultipartUploadCommand` via admin client), `presignUploadPart(key, uploadId, partNumber)` (`UploadPartCommand`, signed via the lazily-constructed presigning client), `completeMultipartUpload(key, uploadId, parts)` (`CompleteMultipartUploadCommand` via admin client — its success response is itself the existence proof per TD-04, no follow-up `HeadObject`)
4. Implement single-file and read/write methods on `StorageService`: `presignPutObject(key)` (single-PUT presigned URL), `headObject(key)` (verification for the non-multipart completion path), `presignGetObject(key, { download?, filename? })` (no `ResponseContentDisposition` when `download` is falsy; `ResponseContentDisposition: 'attachment; filename="<filename>"'` when `download` is true — per TD-08's shared-mechanism/distinguishing-parameter design), `getObjectBody(key)` (returns a `Readable` for the worker's ffprobe/ffmpeg input), `putObject(key, body)` (worker's thumbnail upload)
5. The presigning `S3Client` (`endpoint: storageConfig.publicEndpoint`) is constructed lazily on first call to any presign method, not in the constructor — this guards against `STORAGE_PUBLIC_ENDPOINT` being absent in the worker process (optional per TD-09); calling a presign method without `STORAGE_PUBLIC_ENDPOINT` configured throws a clear internal error identifying the missing env var

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.service.integration-spec.ts` | Integration | Bucket bootstrap creates the bucket when absent and is a no-op when already present (idempotent, against local MinIO); presigned upload/get URLs are signed against `STORAGE_PUBLIC_ENDPOINT` while admin operations (`ensureBucketExists`, `createMultipartUpload`, `completeMultipartUpload`, `headObject`) target `STORAGE_INTERNAL_ENDPOINT`; a full multipart create → upload-part → complete round-trip against local MinIO produces a retrievable object |
| `src/storage/storage.module.spec.ts` | Unit | Module compiles with the admin `S3Client` provider wiring |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- On application bootstrap, the configured bucket exists in MinIO — verified via `HeadBucketCommand` succeeding after app start, whether or not the bucket pre-existed
- `presignUploadPart` and `presignGetObject` return URLs whose host matches `STORAGE_PUBLIC_ENDPOINT`, not `STORAGE_INTERNAL_ENDPOINT`
- `completeMultipartUpload` with an ordered, valid `{partNumber, eTag}[]` list assembles the parts into a single retrievable object at `key`
- `headObject` on a key that was never uploaded rejects with a not-found error
- `presignGetObject(key, { download: true, filename })` produces a URL whose signed request carries `ResponseContentDisposition: attachment; filename="<filename>"`; `presignGetObject(key)` without `download` carries no such override

---

### SI-03.4 — Queue Module (BullMQ Registration and Producer)

**Description:** Register the BullMQ connection and the `video-processing` queue, and provide the producer-side service used by the upload-completion endpoint to enqueue processing jobs with the phase's decided retry policy.

**Technical actions:**

- Create `src/queue/queue.module.ts` — `BullModule.forRootAsync({ inject: [queueConfig.KEY], useFactory: (cfg) => ({ connection: { host: cfg.host, port: cfg.port } }) })` plus `BullModule.registerQueue({ name: 'video-processing' })` (per `phase-03-videos/TD-01`)
- Create `src/queue/video-queue.service.ts` — `VideoQueueService` injecting `@InjectQueue('video-processing') private readonly queue: Queue`. Implement `enqueueProcessing(videoId: string): Promise<void>` — `this.queue.add('process-video', { videoId }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } })` (the 3-attempts + exponential backoff configuration TD-04 mandates)
- `QueueModule` exports `VideoQueueService` for consumption by `VideosModule` (producer side, SI-03.6) and is separately imported by the worker (consumer side, SI-03.7)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/queue/video-queue.service.spec.ts` | Unit | `enqueueProcessing` calls `queue.add` with job name `'process-video'`, payload `{ videoId }`, and options `{ attempts: 3, backoff: { type: 'exponential', delay: 5000 } }` (mocked `Queue`) |
| `src/queue/queue.module.spec.ts` | Unit | Module compiles with `BullModule.forRootAsync` + `BullModule.registerQueue` wiring |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Calling `enqueueProcessing(videoId)` adds a job named `'process-video'` to the `video-processing` queue with `{ videoId }` as its data
- The added job is configured with exactly 3 attempts and exponential backoff
- `QueueModule` compiles standalone (no dependency on `VideosModule` or `WorkerModule`)

---

### SI-03.5 — Upload Initiation Endpoint (POST /videos)

**Description:** Implement the draft pre-registration endpoint. The channel is resolved from the authenticated JWT (never client-supplied), a per-video storage key is computed, and the client receives either a single presigned PUT URL or a multipart upload handshake depending on declared file size.

**Technical actions:**

- Add `findByUserId(userId: string): Promise<Channel | null>` to `ChannelsService` — `channelRepository.findOne({ where: { user_id: userId } })`, reusing the same `user_id`-keyed lookup pattern `ChannelsModule` already owns (per TD-04's "no new guard, no client-supplied `channelId`" clause)
- Create `src/videos/dto/create-video.dto.ts` — `CreateVideoDto` with `@IsString() @IsNotEmpty() @MaxLength(255)` `originalFilename`, `@IsInt() @Min(1) @Max(10737418240)` `fileSize` (bytes, capped at 10GB per the phase's capability), `@IsString() @IsOptional()` `contentType`
- Create `src/videos/videos.service.ts` — `createDraft(userId, dto): Promise<{...}>`: resolve the channel via `channelsService.findByUserId(userId)`; create and save a `Video` row with `status: 'draft'`, `channelId`, `originalFilename`, `storageKey: videos/{id}/original`; decide upload path — `fileSize > 104857600` (100MB) uses multipart (`storageService.createMultipartUpload`, then one `presignUploadPart` per 50MB-sized part), otherwise a single `storageService.presignPutObject`; return `{ id, status, upload }` where `upload` is `{ type: 'single', url }` or `{ type: 'multipart', uploadId, parts: [{ partNumber, url }] }`
- Create `src/videos/videos.controller.ts` — `VideosController` with route prefix `'videos'`. Implement `@Post()` calling `videosService.createDraft(user.sub, dto)`, returning 201 with the service's response
- Update `src/videos/videos.module.ts` — import `ChannelsModule` and `StorageModule`, register `VideosController` in `controllers` and `VideosService` in `providers`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/channels/channels.service.spec.ts` | Unit | `findByUserId` returns the matching channel or `null` |
| `src/videos/videos.service.spec.ts` | Unit | `createDraft`: resolves channel from `userId`, picks single-PUT path under the 100MB threshold and multipart above it, computes `storageKey` as `videos/{id}/original` |
| `src/videos/videos.service.integration-spec.ts` | Integration | `createDraft` persists a `videos` row with `status='draft'`, correct `channelId` and `originalFilename`; multipart path creates a real MinIO multipart upload (local instance) |
| `test/videos.e2e-spec.ts` | E2E | `POST /videos` with valid body returns 201 with `{ id, status: 'draft', upload }`; 401 without an access token; 400 on missing/invalid fields; `fileSize` above 10GB returns 400 |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**

- `POST /videos` with a valid body and a valid access token returns 201 with `{ id, status: 'draft', upload }` — a video row is persisted with `channelId` resolved from the caller's own channel, never from the request body
- `POST /videos` without an `Authorization` header returns 401
- `POST /videos` with `fileSize` ≤ 100MB returns a `{ type: 'single', url }` upload handshake; with `fileSize` > 100MB returns a `{ type: 'multipart', uploadId, parts }` handshake
- `POST /videos` with `fileSize` exceeding 10GB (`10737418240` bytes) returns 400 with a validation error
- `POST /videos` with missing `originalFilename` or `fileSize` returns 400 with validation errors

---

### SI-03.6 — Complete Upload Endpoint (POST /videos/:id/complete-upload)

**Description:** Implement the endpoint that verifies the client finished uploading directly to storage, flips the video's status from `draft` to `processing`, and enqueues the background processing job. Verification differs by upload path: a server-side `CompleteMultipartUploadCommand` for multipart, a `HeadObject` check for single-PUT.

**Technical actions:**

- Create `src/videos/dto/complete-upload.dto.ts` — `CompleteUploadDto` with `@IsOptional() @IsString()` `uploadId` and `@IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => UploadPartDto)` `parts`; nested `UploadPartDto` with `@IsInt() @Min(1)` `partNumber` and `@IsString() @IsNotEmpty()` `eTag`
- Implement `completeUpload(userId, videoId, dto): Promise<{ id, status }>` in `VideosService` — load the video by `id`; if not found OR `video.channelId !== (await channelsService.findByUserId(userId))?.id`, throw `VideoNotFoundException` (per TD-04's IDOR-by-construction design — ownership mismatch reads as "not found", never as a distinct 403)
- In the same method, branch verification by presence of `dto.uploadId`: when present, call `storageService.completeMultipartUpload(video.storageKey, dto.uploadId, dto.parts)` (the successful response is the existence proof, per TD-04 — no follow-up check); when absent, call `storageService.headObject(video.storageKey)`, catching a not-found error and re-throwing as `UploadVerificationFailedException` (new `DomainException` subclass, `errorCode: 'UPLOAD_VERIFICATION_FAILED'`, `httpStatus: 409`)
- On successful verification: update the video row `status: 'processing'`, then call `videoQueueService.enqueueProcessing(video.id)`; return `{ id: video.id, status: 'processing' }`
- Add `@Post(':id/complete-upload')` to `VideosController`, returning 200 with the service's response; update `src/videos/videos.module.ts` to import `QueueModule`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `completeUpload`: multipart path calls `completeMultipartUpload`, single-PUT path calls `headObject`; ownership mismatch and missing video both throw `VideoNotFoundException`; a storage not-found on `headObject` throws `UploadVerificationFailedException`; success path flips status and calls `enqueueProcessing` |
| `src/videos/videos.service.integration-spec.ts` | Integration | `completeUpload` persists `status='processing'` after a real multipart or single-PUT completion against local MinIO; a job is visible in the `video-processing` queue afterward |
| `test/videos.e2e-spec.ts` | E2E | `POST /videos/:id/complete-upload` returns 200 with `{ id, status: 'processing' }` for the owning user; 404 `VIDEO_NOT_FOUND` for another user's video or an unknown id; 409 `UPLOAD_VERIFICATION_FAILED` when the object was never actually uploaded |

**Dependencies:** SI-03.5, SI-03.4

**Acceptance criteria:**

- `POST /videos/:id/complete-upload` for the video's own channel, with a genuinely-uploaded object in storage, returns 200 with `{ id, status: 'processing' }`, and a `process-video` job is enqueued with `{ videoId: id }`
- `POST /videos/:id/complete-upload` for a video belonging to a different channel returns 404 with `VIDEO_NOT_FOUND` — no distinction from a truly-nonexistent id
- `POST /videos/:id/complete-upload` when the referenced storage object was never uploaded returns 409 with `UPLOAD_VERIFICATION_FAILED`
- Multipart completion calls `CompleteMultipartUploadCommand` with the ordered `{partNumber, eTag}` list and performs no separate `HeadObject` afterward
- Single-PUT completion calls `HeadObjectCommand` against the video's `storageKey`

---

### SI-03.7 — Standalone Worker Application Bootstrap

**Description:** Bootstrap the standalone NestJS worker application via `NestFactory.createApplicationContext` — a separate process/container with no HTTP listener, isolating CPU-bound ffmpeg work from the API. Provision the container with the `ffmpeg`/`ffprobe` binaries the next SI depends on.

**Technical actions:**

- Create `src/worker/worker.module.ts` — `WorkerModule` importing `ConfigModule.forRoot({ isGlobal: true, load: [storageConfig, queueConfig, databaseConfig], validationSchema: envValidationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`, `TypeOrmModule.forRootAsync` (same `databaseConfig`-driven factory `AppModule` uses, `autoLoadEntities: true`, `synchronize: false`), `TypeOrmModule.forFeature([Video])`, `StorageModule`, `BullModule.forRootAsync` + `BullModule.registerQueue({ name: 'video-processing' })` (consumer side — the worker configures its own root connection to the same Redis instance, independent of the API's)
- Create `src/worker/main.ts` — `NestFactory.createApplicationContext(WorkerModule)`; no `app.listen()` call, since the worker serves no HTTP traffic (per `phase-03-videos/TD-05`)
- Add `start:worker` (`node dist/worker/main`) and `start:worker:dev` (`nest start --watch --entryFile worker/main`) scripts to `nestjs-project/package.json`
- Create `nestjs-project/Dockerfile.worker` — same base image as `Dockerfile.dev` (`node:25.6.0-slim`), adding `apt install -y ffmpeg` alongside the existing `procps curl`, so `ffprobe`/`ffmpeg` CLI binaries are available to `execa` (per TD-06's "pinned explicitly in the worker's Dockerfile")
- Add a `video-worker` service to `nestjs-project/compose.yaml` — `build: { context: ., dockerfile: Dockerfile.worker }`, `command: npm run start:worker:dev`, `volumes: - .:/home/node/app`, `depends_on: db (service_healthy), redis (service_started), minio (service_healthy)` — no `ports` mapping (no HTTP surface)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/worker/worker.module.spec.ts` | Unit | Module compiles with `TypeOrmModule.forRootAsync`, `TypeOrmModule.forFeature([Video])`, `StorageModule`, and `BullModule` wiring |

**Dependencies:** SI-03.1, SI-03.2, SI-03.3, SI-03.4

**Acceptance criteria:**

- `docker compose up video-worker` starts the container and it stays running without binding any host port
- `docker compose exec video-worker ffmpeg -version` and `docker compose exec video-worker ffprobe -version` both exit 0
- The worker process connects to Postgres, Redis, and MinIO using the same credentials the API uses, without starting an HTTP server

---

### SI-03.8 — Video Processing Job Handler (ffprobe/ffmpeg, Status Transitions, Retry)

**Description:** Implement the BullMQ job handler that performs the actual media inspection and thumbnail generation, and writes the phase's success/failure terminal states atomically.

**Technical actions:**

- Create `src/worker/video.processor.ts` — `@Processor('video-processing') export class VideoProcessor extends WorkerHost`. In `async process(job: Job<{ videoId: string }>)`: load the `Video` row by `job.data.videoId`; set `status = 'processing'` at the start of every attempt (idempotent — the same write whether this is attempt 1 or a retry)
- Download the source object via `storageService.getObjectBody(video.storageKey)` to a temp file path; run `ffprobe` via dynamic `await import('execa')` (`execa('ffprobe', ['-print_format', 'json', '-show_format', '-show_streams', inputPath])`), parse `stdout` as JSON, extract `duration`
- Create `src/worker/thumbnail-offset.util.ts` — `computeThumbnailOffset(duration: number): number` returning `3` when `duration >= 3`, else `0` (per `phase-03-videos/TD-06`'s fixed-offset-with-clamp rule). In the processor, run `ffmpeg` (`execa('ffmpeg', ['-ss', String(offset), '-i', inputPath, '-vframes', '1', thumbnailPath])`) and upload the result via `storageService.putObject('videos/{videoId}/thumbnail.jpg', thumbnailBuffer)`
- On success: perform one single atomic `UPDATE` on the video row — `status: 'ready'`, `duration`, `thumbnailKey: 'videos/{videoId}/thumbnail.jpg'` — all three fields land together so no partially-written state is ever visible (per TD-04's success-path clause)
- On failure (any `ffprobe`/`ffmpeg`/storage exception): catch it, perform one single atomic `UPDATE` — `status: 'error'`, `error_message: err.message` — then re-throw so the exception surfaces to BullMQ, whose configured `attempts: 3` + exponential backoff (SI-03.4) governs whether the job runs again; after the 3rd failed attempt the `error` write stands permanently (per TD-04's failure-path clause)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/worker/thumbnail-offset.util.spec.ts` | Unit | Returns `3` when `duration >= 3`; returns `0` when `duration < 3` |
| `src/worker/video.processor.integration-spec.ts` | Integration | Success path (real ffprobe/ffmpeg + local MinIO) lands `status='ready'` with `duration` and `thumbnailKey` in a single write; failure path (corrupt/unreadable input) lands `status='error'` with `error_message` set and re-throws; `status` resets to `'processing'` at the start of each retry attempt; after 3 failed attempts the job stays failed and `status='error'` persists |

**Dependencies:** SI-03.7

**Acceptance criteria:**

- Processing a valid video file writes `status='ready'`, a numeric `duration`, and a `thumbnailKey` of `videos/{videoId}/thumbnail.jpg` — all three in the same database transaction/statement
- The generated thumbnail is captured at the 3-second offset for videos ≥3s, and at the 0-second offset (first frame) for videos <3s
- Processing a file that fails `ffprobe`/`ffmpeg` writes `status='error'` with a non-null `error_message`, and the underlying exception propagates so BullMQ retries the job
- After the job's 3rd attempt also fails, the video remains in `status='error'` — no further automatic retry occurs
- Each retry attempt re-sets `status='processing'` before re-running the ffprobe/ffmpeg steps

---

### SI-03.9 — Streaming Endpoint (GET /videos/:id/stream)

**Description:** Implement the endpoint that issues a presigned GET URL for inline playback, gated by the video's processing status. No ownership check applies — any `ready` video is universally streamable in this phase, per TD-08's status-only gate.

**Technical actions:**

- Implement `getStreamUrl(videoId): Promise<{ url: string }>` in `VideosService` — load the video by `id`; if not found or `status !== 'ready'`, throw `VideoNotFoundException` (uniform 404 across `draft`/`processing`/`error`/nonexistent, per TD-08's status-gating clause); otherwise call `storageService.presignGetObject(video.storageKey)` (no `ResponseContentDisposition` override — inline playback) and return `{ url }`
- Add `@Public() @Get(':id/stream')` to `VideosController` — returns 200 with `{ url }`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `getStreamUrl` returns a presigned URL for `status='ready'`; throws `VideoNotFoundException` for `draft`/`processing`/`error`/nonexistent id |
| `test/videos.e2e-spec.ts` | E2E | `GET /videos/:id/stream` returns 200 with `{ url }` for a `ready` video (no `Authorization` header needed); returns 404 `VIDEO_NOT_FOUND` for `draft`/`processing`/`error`/unknown id |

**Dependencies:** SI-03.6

**Acceptance criteria:**

- `GET /videos/:id/stream` for a `ready` video returns 200 with `{ url }`, a presigned GET URL with no `Content-Disposition` override, without requiring an access token
- `GET /videos/:id/stream` for a video in `draft`, `processing`, or `error` returns 404 with `VIDEO_NOT_FOUND`
- `GET /videos/:id/stream` for a nonexistent video id returns 404 with `VIDEO_NOT_FOUND` — indistinguishable from the non-`ready` case

---

### SI-03.10 — Download Endpoint (GET /videos/:id/download)

**Description:** Implement the endpoint that issues a presigned GET URL forcing a Save-As download, using the same status gate and the same presigned `GetObjectCommand` mechanism as streaming, differing only in the `ResponseContentDisposition` signing parameter.

**Technical actions:**

- Implement `getDownloadUrl(videoId): Promise<{ url: string }>` in `VideosService` — same status gate as `getStreamUrl` (`VideoNotFoundException` for any non-`ready` status or missing video); calls `storageService.presignGetObject(video.storageKey, { download: true, filename: video.originalFilename })`, which signs with `ResponseContentDisposition: 'attachment; filename="<originalFilename>"'` (per TD-08 — `originalFilename` is the value persisted at draft-registration time, per TD-04)
- Add `@Public() @Get(':id/download')` to `VideosController` — returns 200 with `{ url }`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `getDownloadUrl` returns a presigned URL carrying `ResponseContentDisposition` with the video's `originalFilename`; same status-gating behavior as `getStreamUrl` |
| `test/videos.e2e-spec.ts` | E2E | `GET /videos/:id/download` returns 200 with `{ url }` for a `ready` video, the URL's signed `ResponseContentDisposition` containing the original filename; 404 `VIDEO_NOT_FOUND` for any non-`ready` status or unknown id |

**Dependencies:** SI-03.6

**Acceptance criteria:**

- `GET /videos/:id/download` for a `ready` video returns 200 with `{ url }`, a presigned GET URL whose `ResponseContentDisposition` is `attachment; filename="<the video's originalFilename>"`
- `GET /videos/:id/download` for a video in `draft`, `processing`, or `error` returns 404 with `VIDEO_NOT_FOUND`
- The only difference between the streaming and download URLs for the same video is the `ResponseContentDisposition` signing parameter — both target the same `storageKey`

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Reused as the public video identifier (`phase-03-videos/TD-07`) |
| channelId | uuid | FK → channels.id, not null | Resolved server-side from the JWT-authenticated user's own channel — never client-supplied (TD-04) |
| originalFilename | varchar | not null | Supplied by the client at draft creation; source of the download `Content-Disposition` filename (TD-04, TD-08) |
| storageKey | varchar | not null | Object key of the original file — `videos/{id}/original` (TD-03's per-video prefix layout) |
| status | enum | not null, default `'draft'`, values: `'draft'`, `'processing'`, `'ready'`, `'error'` | Single status column, no separate history table (TD-04) |
| duration | real | nullable | ffprobe-reported seconds; populated together with `status='ready'` (TD-04) |
| thumbnailKey | varchar | nullable | Object key `videos/{videoId}/thumbnail.jpg`; populated together with `status='ready'` (TD-04, TD-06) |
| error_message | text | nullable | Populated only when `status='error'`, otherwise `null` (TD-04) |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one, owning side via `channelId`)
**Indexes:** `(channelId)` — FK lookup for ownership checks

---

### API Contracts

#### POST /videos (SI-03.5)

**Request headers:**
- Authorization: Bearer \<access_token\>
- Content-Type: application/json

**Request body:**
- originalFilename: string, required — max 255 characters
- fileSize: number, required — bytes, min 1, max 10737418240 (10GB)
- contentType: string, optional

**Response 201:**
- id: string (uuid)
- status: `"draft"`
- upload: `{ type: "single", url: string }` (fileSize ≤ 100MB) OR `{ type: "multipart", uploadId: string, parts: [{ partNumber: number, url: string }] }` (fileSize > 100MB)

**Error responses:**
- 401: when the access token is missing or invalid
- 400 validation error: when the request body fails schema validation, including `fileSize` above the 10GB cap

---

#### POST /videos/:id/complete-upload (SI-03.6)

**Request headers:**
- Authorization: Bearer \<access_token\>
- Content-Type: application/json

**Request body:**
- uploadId: string, optional — present only for the multipart path
- parts: `{ partNumber: number, eTag: string }[]`, optional — present only for the multipart path, ordered by `partNumber`

**Response 200:**
- id: string (uuid)
- status: `"processing"`

**Error responses:**
- 401: when the access token is missing or invalid
- 404 VIDEO_NOT_FOUND: when the video does not exist or does not belong to the caller's own channel
- 409 UPLOAD_VERIFICATION_FAILED: when the referenced object was not found in storage (upload did not actually complete)

---

#### GET /videos/:id/stream (SI-03.9)

**Response 200:**
- url: string — presigned GET URL, no `Content-Disposition` override, for inline playback

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the video does not exist, or `status` is not `'ready'`

---

#### GET /videos/:id/download (SI-03.10)

**Response 200:**
- url: string — presigned GET URL signed with `ResponseContentDisposition: attachment; filename="<originalFilename>"`

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the video does not exist, or `status` is not `'ready'`

#### Validation Rules — Upload Initiation

| Field | Rule | Error message |
|-------|------|----------------|
| originalFilename | Required, max 255 characters | originalFilename must be shorter than or equal to 255 characters |
| fileSize | Required, integer, min 1, max 10737418240 | fileSize must not be greater than 10737418240 |

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Notes |
|----------|--------|----------------|-------|
| POST /videos | | ✓ | `channelId` resolved from JWT via `ChannelsService.findByUserId`; existing `JwtAuthGuard`, no new guard (TD-04) |
| POST /videos/:id/complete-upload | | ✓ | Ownership enforced by comparing the video's `channelId` against the caller's own channel; mismatch reads as 404 (TD-04) |
| GET /videos/:id/stream | ✓ | | No ownership check; gated only by `status='ready'` (TD-08) — no visibility/privacy concept exists yet this phase |
| GET /videos/:id/download | ✓ | | Same as streaming |

---

### Error Catalog

**Error response format:** unchanged from Phase 02 — `{ statusCode: number, error: string, message: string }`, mapped by the existing `DomainExceptionFilter`.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | `POST /videos/:id/complete-upload` with an unknown id or a video owned by another channel; `GET /videos/:id/stream` or `GET /videos/:id/download` with an unknown id or `status !== 'ready'` |
| UPLOAD_VERIFICATION_FAILED | 409 | Uploaded object was not found in storage | `POST /videos/:id/complete-upload`'s `HeadObject` (single-PUT path) or `CompleteMultipartUploadCommand` (multipart path) fails to find the referenced object |

---

### Events/Messages

**Queue:** `video-processing` (BullMQ, via `@nestjs/bullmq`'s `BullModule.registerQueue`, per `phase-03-videos/TD-01`). The API process registers the queue as a producer (SI-03.4/SI-03.6); the standalone worker process registers the same queue name as a consumer (SI-03.7/SI-03.8) — each process configures its own `BullModule.forRootAsync` connection to the same Redis instance.

**Job name:** `process-video`

**Job data contract (payload):**

| Field | Type | Notes |
|-------|------|-------|
| videoId | string (uuid) | The `Video` row's `id` — the processor loads the full row from Postgres; no other data is passed through the job |

**Job options:** `{ attempts: 3, backoff: { type: 'exponential', delay: 5000 } }` — set once at `queue.add()` time (SI-03.4); a job that exhausts all 3 attempts stays failed permanently, per `phase-03-videos/TD-04`.

**Job lifecycle events this phase relies on:**

| Event | Trigger | Effect |
|-------|---------|--------|
| Enqueue | `POST /videos/:id/complete-upload` verifies the upload succeeded (SI-03.6) | `VideoQueueService.enqueueProcessing(videoId)` adds a `process-video` job; the video row is updated to `status='processing'` in the same request |
| Processing start (per attempt) | BullMQ dispatches the job to `VideoProcessor.process()` — on the first attempt and again on every retry (SI-03.8) | The handler re-sets `status='processing'` on the video row at the start of each attempt, idempotently |
| Completion success | `ffprobe` + `ffmpeg` + thumbnail upload all succeed within `process()` (SI-03.8) | One atomic update: `status='ready'`, `duration`, `thumbnailKey` — all three land together, no partially-written state is ever visible |
| Completion failure (per attempt) | Any `ffprobe`/`ffmpeg`/storage exception inside `process()` (SI-03.8) | One atomic update: `status='error'`, `error_message`; the handler re-throws so BullMQ's `attempts: 3` + exponential backoff decides whether to retry. After the 3rd failure the `error` write stands permanently — no further automatic retry; manual re-enqueue is out of scope for this phase |

---

## Dependency Map

```
SI-03.1 (no deps)
├── SI-03.2
│   └── SI-03.5
├── SI-03.3
│   └── SI-03.5
└── SI-03.4
    └── SI-03.6

SI-03.5 + SI-03.4
└── SI-03.6
    ├── SI-03.9
    └── SI-03.10

SI-03.1 + SI-03.2 + SI-03.3 + SI-03.4
└── SI-03.7
    └── SI-03.8
```

Linearized implementation order: SI-03.1 → SI-03.2, SI-03.3, SI-03.4 (parallel) → SI-03.5 → SI-03.6 → SI-03.9, SI-03.10 (parallel); SI-03.7 → SI-03.8 (worker track, may run in parallel with SI-03.5/SI-03.6 once SI-03.1–SI-03.4 land)

## Deliverables

- [ ] SI-03.1 — Dependencies, Configuration Namespaces, and Docker Compose
- [ ] SI-03.2 — Video Entity and Migration
- [ ] SI-03.3 — Storage Module (Dual S3 Clients, Presigned Operations, Bucket Bootstrap)
- [ ] SI-03.4 — Queue Module (BullMQ Registration and Producer)
- [ ] SI-03.5 — Upload Initiation Endpoint (POST /videos)
- [ ] SI-03.6 — Complete Upload Endpoint (POST /videos/:id/complete-upload)
- [ ] SI-03.7 — Standalone Worker Application Bootstrap
- [ ] SI-03.8 — Video Processing Job Handler (ffprobe/ffmpeg, Status Transitions, Retry)
- [ ] SI-03.9 — Streaming Endpoint (GET /videos/:id/stream)
- [ ] SI-03.10 — Download Endpoint (GET /videos/:id/download)

**Full test suites:**

- [ ] All SI tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Project builds successfully (`docker compose exec nestjs-api npm run build`)
- [ ] `docker compose up video-worker` starts without a bound HTTP port; `ffmpeg -version` / `ffprobe -version` both succeed inside the container
- [ ] `minio` console reachable at `localhost:9001`; `redis` responds to `redis-cli ping` inside the Docker network

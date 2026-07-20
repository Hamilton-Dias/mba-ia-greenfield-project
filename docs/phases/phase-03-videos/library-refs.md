---
libs:
  "@nestjs/bullmq":
    version: "^11.0.4"
    context7_id: "n/a - context7 unavailable, sourced via WebSearch"
    fetched_at: "2026-07-19T22:58:37-03:00"
  "bullmq":
    version: "^5.80.8"
    context7_id: "n/a - context7 unavailable, sourced via WebSearch"
    fetched_at: "2026-07-19T22:58:37-03:00"
  "execa":
    version: "^10.0.0"
    context7_id: "n/a - context7 unavailable, sourced via WebSearch"
    fetched_at: "2026-07-19T22:58:37-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1090.0"
    context7_id: "n/a - context7 unavailable, sourced via WebSearch"
    fetched_at: "2026-07-19T22:58:37-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1090.0"
    context7_id: "n/a - context7 unavailable, sourced via WebSearch"
    fetched_at: "2026-07-19T22:58:37-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-19T22:41:52-03:00"
---

# Library Reference Cache — phase-03-videos

Distilled usage notes for the libraries this phase's TDs commit to. None of these
packages are installed yet in `nestjs-project/package.json` (verified 2026-07-19) — no
version-overlap conflicts exist with the project's current `@nestjs/*` ^11.0.x line.
`@nestjs/bullmq` ^11.0.4 targets Nest 11, matching the installed core packages.

TD source: `docs/decisions/technical-decisions-phase-03-videos.md` — TD-01 (queue), TD-06
(ffmpeg/ffprobe invocation), and TD-02/TD-08/TD-09 (presigned S3-compatible upload/stream/
download against MinIO). No TD in this doc carries a literal `**Libraries:**` line; the
package names below are the ones named in each TD's Decision/Option prose.

---

### @nestjs/bullmq

Nest's official BullMQ integration module (decided in TD-01, Option A).

**Root registration** (`AppModule` or a dedicated `QueueModule`):
```ts
BullModule.forRoot({
  connection: { host: process.env.REDIS_HOST, port: +process.env.REDIS_PORT },
});
```

**Registering a queue** (in the module that owns the producer, e.g. `VideosModule`):
```ts
BullModule.registerQueue({ name: 'video-processing' });
```

**Producer side** — inject with `@InjectQueue`:
```ts
constructor(@InjectQueue('video-processing') private readonly queue: Queue) {}

await this.queue.add('process-video', { videoId }, {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
});
```

**Consumer side** — modern API is `@Processor` + `WorkerHost` (NOT the older `@Process`
decorator, which is Bull-only and does not apply to BullMQ):
```ts
@Processor('video-processing')
export class VideoProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string }>): Promise<void> {
    await job.updateProgress(10);
    // ffprobe -> ffmpeg -> upload thumbnail -> update video row
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    // optional: logging hook; DB status write itself happens in `process()`'s catch per TD-04
  }
}
```
`WorkerHost` is what TD-05's standalone worker process (`NestFactory.createApplicationContext`)
bootstraps alongside `BullModule.registerQueue` — the worker app never calls `NestFactory.create()`
since it serves no HTTP traffic.

---

### bullmq

Underlying queue/worker engine that `@nestjs/bullmq` wraps; used directly for lower-level details
not exposed by the Nest wrapper (job options shape, progress/retry semantics).

**Retries + exponential backoff** (TD-04 mandates `attempts: 3` + exponential backoff):
```ts
await queue.add('process-video', payload, {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 }, // retry N waits 2^(N-1) * delay ms
});
```
A job that exhausts all attempts stays failed; BullMQ does not auto-retry further — this is what
TD-04 relies on to land a video in a durable `error` status after the 3rd failure.

**Progress reporting** (maps to a video's transcoding/inspection progress):
```ts
await job.updateProgress(60);
const current = await job.progress; // 60
```

**Job identity inside the processor** — `job.data` carries whatever payload the producer passed
(e.g. `{ videoId }`); the processor is responsible for loading the `videos` row, running
TD-06's ffprobe/ffmpeg steps, and writing the terminal `ready`/`error` status per TD-04.

---

### execa

Chosen in TD-06 (Option A) to spawn `ffprobe`/`ffmpeg` as child processes instead of the archived
`fluent-ffmpeg` wrapper.

**Compatibility note (important for this phase):** `execa` has been a pure ESM package since v6,
and current versions (9.x/10.x) lead with a tagged-template `$`/`execa` API. `nestjs-project`
has no `"type": "module"` in `package.json` (CommonJS by default) and compiles with
`tsconfig.json`'s `"module": "nodenext"`. A `.ts` file compiled as CJS cannot `require('execa')`
directly. Two viable paths for the worker code that calls it:
1. Use a dynamic `await import('execa')` inside the async function/module that needs it (works
   from CJS output, since dynamic `import()` is always available regardless of module system).
2. Isolate ffmpeg/ffprobe invocation in its own small ESM entry point if the worker process
   (TD-05's standalone `createApplicationContext` app) can tolerate `"type": "module"` for that
   file tree — more invasive, only worth it if execa's ESM-only surface causes friction elsewhere.
Option 1 (dynamic import) is the lower-risk default for a NestJS/TypeORM codebase that is
otherwise entirely CommonJS.

**Basic invocation + JSON parsing** (ffprobe):
```ts
const { execa } = await import('execa');
const { stdout } = await execa('ffprobe', [
  '-print_format', 'json', '-show_format', '-show_streams', inputPath,
]);
const probe = JSON.parse(stdout);
const duration = Number(probe.format.duration);
```

**Thumbnail extraction** (ffmpeg, per TD-06's fixed 3s offset + <3s clamp to 0s):
```ts
const offset = duration < 3 ? 0 : 3;
await execa('ffmpeg', ['-ss', String(offset), '-i', inputPath, '-vframes', '1', thumbnailPath]);
```

**Error handling** — a non-zero exit rejects the returned promise with an `ExecaError` carrying
`stdout`, `stderr`, `exitCode`, `failed`, `timedOut`, `killed`; catching it is exactly the trigger
for TD-04's failure path (`status = 'error'` + `error_message`, then re-throw so BullMQ's retry/
backoff takes over). `stdout`/`stderr` are returned as strings with the trailing newline stripped
(no manual `.trim()` needed).

---

### @aws-sdk/client-s3

S3-compatible client used for both admin-style operations (bucket bootstrap, worker's direct
reads/writes, multipart completion) and as the base client wrapped by the presigner. Same
package works against MinIO or real S3 — only `endpoint`/`forcePathStyle`/credentials differ.

**Client construction against MinIO** (TD-09's dual-endpoint split — internal for admin/worker,
public for anything that will be handed to an external client as a presigned URL):
```ts
const adminS3 = new S3Client({
  endpoint: process.env.STORAGE_INTERNAL_ENDPOINT, // e.g. http://minio:9000
  region: 'us-east-1',
  forcePathStyle: true, // required for MinIO — it doesn't support virtual-hosted-style bucket URLs
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY,
    secretAccessKey: process.env.STORAGE_SECRET_KEY,
  },
});

const presigningS3 = new S3Client({
  endpoint: process.env.STORAGE_PUBLIC_ENDPOINT, // e.g. http://localhost:9000 — API only
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: { /* same as above */ },
});
```

**Bucket bootstrap** (TD-09's idempotent ensure-bucket-exists, run on API bootstrap):
```ts
try {
  await adminS3.send(new HeadBucketCommand({ Bucket: bucketName }));
} catch (err) {
  if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
    await adminS3.send(new CreateBucketCommand({ Bucket: bucketName }));
  } else {
    throw err;
  }
}
```

**Multipart upload (server-side orchestration, TD-02 + TD-04)**:
```ts
// 1. API initiates
const { UploadId } = await adminS3.send(new CreateMultipartUploadCommand({ Bucket, Key }));

// 2. API issues one presigned URL per part (client PUTs bytes directly, tracks ETag per part)
const url = await getSignedUrl(presigningS3, new UploadPartCommand({
  Bucket, Key, UploadId, PartNumber: n,
}), { expiresIn: 3600 });

// 3. Client calls /videos/:id/complete-upload with the ordered {partNumber, eTag}[] list;
//    API completes server-side — this call itself is the existence proof (TD-04), no HeadObject needed after.
await adminS3.send(new CompleteMultipartUploadCommand({
  Bucket, Key, UploadId,
  MultipartUpload: { Parts: parts.map(p => ({ PartNumber: p.partNumber, ETag: p.eTag })) },
}));
```

**Single-PUT path verification** (small files, no multipart — TD-04's `HeadObject` check):
```ts
await adminS3.send(new HeadObjectCommand({ Bucket, Key })); // throws if not found
```

**Worker's direct read/write** (TD-05/TD-06 — no presigning, worker only uses the internal
admin client): `GetObjectCommand` to fetch the source file body for ffprobe/ffmpeg, `PutObjectCommand`
to upload the generated thumbnail to the TD-03 key (`videos/{videoId}/thumbnail.jpg`).

---

### @aws-sdk/s3-request-presigner

Generates time-limited signed URLs for direct client access to S3-compatible storage —
used for both the upload handshake (TD-02, per-part `UploadPartCommand`, and single-file
`PutObjectCommand`) and streaming/download (TD-08, `GetObjectCommand`).

**Core call shape**:
```ts
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const url = await getSignedUrl(presigningS3Client, command, { expiresIn: 3600 });
```
Must be signed with the client configured against `STORAGE_PUBLIC_ENDPOINT` (TD-09) — signing
against the internal Compose DNS name (`minio:9000`) produces a URL a browser cannot resolve,
and the signature can't be repaired by rewriting the host after the fact (the host is bound into
the signature itself).

**Streaming vs. download — same command, one parameter differs** (TD-08):
```ts
// Streaming (inline playback, <video> src)
const streamUrl = await getSignedUrl(presigningS3, new GetObjectCommand({ Bucket, Key }), {
  expiresIn: 3600,
});

// Download (forces Save-As instead of inline render)
const downloadUrl = await getSignedUrl(presigningS3, new GetObjectCommand({
  Bucket, Key,
  ResponseContentDisposition: `attachment; filename="${originalFilename}"`,
}), { expiresIn: 3600 });
```
`Range` request support for scrubbing/seeking is native to S3-compatible storage — no custom
byte-range handling needed in the API for either URL.

**Known gotcha (verified against AWS SDK v3 issue tracker):** presigned URLs can produce a
signature mismatch if certain parameters (`ContentDisposition`, `ServerSideEncryption`, and
similarly-named ones) are attached to a `PutObjectCommand` used for presigning rather than a
`GetObjectCommand` — this doesn't affect TD-08's `ResponseContentDisposition` usage above (that's
a `GetObjectCommand`-only, read-side parameter, not the same field), but is worth knowing if a
future SI tries to set upload-time content-disposition via a presigned `PutObjectCommand`.

---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 4
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-19T22:16:27-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-19T19:11:11-03:00"
issues:
  - id: IC-1
    status: resolved
    summary: "Presigned direct-to-storage (TD-02/TD-08) unreconciled with Docker Compose internal-DNS networking"
    resolved_by: phase-03-videos/TD-09
  - id: AMB-1
    status: resolved
    summary: "TD-08 doesn't address Content-Disposition override needed to force download vs. inline streaming"
    resolved_by: phase-03-videos/TD-08
  - id: AMB-2
    status: resolved
    summary: "Draft→processing transition trigger (client confirm vs. worker/event detection) undocumented"
    resolved_by: phase-03-videos/TD-04
  - id: AMB-3
    status: resolved
    summary: "Thumbnail frame/timestamp selection strategy unspecified in capability or TD-06"
    resolved_by: phase-03-videos/TD-06
  - id: MD-1
    status: resolved
    summary: "No TD decides the object storage backend/vendor (self-hosted MinIO vs. cloud S3-compatible)"
    resolved_by: phase-03-videos/TD-09
  - id: DG-1
    status: resolved
    summary: "Object storage compose.yaml service not planned, unlike Redis (TD-01) and worker container (TD-05)"
    resolved_by: phase-03-videos/TD-09
  - id: AMB-4
    status: open
    summary: "TD-09 ambiguous on whether the worker (TD-05) actually needs STORAGE_PUBLIC_ENDPOINT/presigning"
  - id: AMB-5
    status: open
    summary: "TD-04's completion-endpoint trigger doesn't reconcile with TD-02's multipart CompleteMultipartUpload step"
  - id: MD-2
    status: open
    summary: "No TD decides how the MinIO bucket/root credentials are provisioned/seeded on startup"
  - id: MD-3
    status: open
    summary: "No TD/entity decision covers where TD-08's download filename parameter is sourced from"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._ — IC-1 is resolved (see `## Resolved Issues`). No new inconsistencies found: TD-09's dual-endpoint model is internally consistent with TD-02 and TD-08's direct-client-to-storage design, and no other pair of decided TDs implies mutually exclusive behavior.

### Ambiguities

- **AMB-4** — TD-09's Recommendation states "The API/worker hold two configured endpoint values — `STORAGE_INTERNAL_ENDPOINT` ... and `STORAGE_PUBLIC_ENDPOINT` ... used only when constructing the `S3Client` that signs presigned URLs," phrasing that lumps the worker in with the API as a holder of both endpoints. But presigned URLs are only ever generated for end-user-facing operations — TD-02 (upload initiation) and TD-08 (streaming/download) — both of which are literally described as API responsibilities; the worker (TD-05, a `createApplicationContext` job processor with no HTTP-facing role, per `## Decisions Detail`) has no described code path that issues a presigned URL to anyone. If the worker only ever performs admin-style `GetObject`/`PutObject` calls against storage (to fetch the source file for `ffprobe`/`ffmpeg` and to upload the generated thumbnail), it plausibly only needs `STORAGE_INTERNAL_ENDPOINT` and never touches `STORAGE_PUBLIC_ENDPOINT` or the presigning `S3Client` at all. This is not yet decided either way, and it has a concrete downstream effect: whether `STORAGE_PUBLIC_ENDPOINT` is a required env var (per the inherited Joi validation-schema convention) for the worker process, or API-only. Explicit choice: clarify in TD-09 (or a revision) whether the worker constructs a presigning `S3Client` at all, or only ever uses the internal-endpoint client for admin operations.

- **AMB-5** — TD-04's revised Recommendation decides the draft→processing trigger as "a client call to a dedicated completion endpoint (e.g. `POST /videos/:id/complete-upload`), which verifies the object actually exists in storage (a `HeadObject`-equivalent call ...) before flipping `draft` → `processing`." This closes the original AMB-2 (which mechanism/who-calls-what) for the general case, but does not reconcile with TD-02's "multipart for large files" requirement: S3-compatible multipart uploads require an explicit `CompleteMultipartUploadCommand` call (assembling the uploaded parts via their ETags) before the object exists as a single, readable object — a `HeadObject` call against an in-progress (not-yet-completed) multipart upload will not see a finished object. TD-04's description of the completion endpoint only mentions verifying existence, not performing (or delegating) the multipart-assembly step. Two materially different designs are still open: (a) the client completes the multipart upload directly against storage first (using a presigned "complete" URL or the storage SDK), then calls the backend's `/complete-upload` endpoint purely for the `HeadObject` check + status flip; or (b) the client sends the collected part ETags to the backend's `/complete-upload` endpoint, and the backend itself issues `CompleteMultipartUploadCommand` (via the internal-endpoint admin client) before doing its `HeadObject` verification. This changes the endpoint's request payload and what "verifies the object exists" actually means for a multipart upload. Explicit choice: TD-04 (or TD-02) needs a revision stating which side performs the multipart-completion call.

### Missing Decisions

- **MD-2** — TD-09 decides to add MinIO as a new `compose.yaml` service (resolving the prior DG-1/MD-1), but no TD addresses how the bucket TD-03 designates (single bucket, per-video prefix) actually gets created, nor how MinIO's root credentials are generated and wired into the API's/worker's storage config. Unlike Postgres (which the project already handles via TypeORM migrations) or Redis (which needs no bucket-equivalent bootstrap step), MinIO requires an explicit bucket-creation call (SDK `CreateBucketCommand`/`ensureBucket`-on-boot, a one-off `mc mb` init step in `compose.yaml`, or a documented manual step) and requires access-key/secret credentials that must match between the `minio` service's env (`MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`) and the API/worker's `S3Client` config (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` or equivalent). None of this is decided anywhere in `## Decisions Detail`. Explicit choice: run `/research phase-03-videos` (or `/decide`) to add a TD (or a revision to TD-09) selecting the bucket-provisioning mechanism and the credential-sourcing/sharing strategy across the `minio`, API, and worker services.

- **MD-3** — TD-08's revised Recommendation specifies the download URL is "signed with `ResponseContentDisposition: 'attachment; filename=\"<original-filename>\"'`," but no TD or the `## Scope`/entity-design content decided anywhere in `context.md` says where `<original-filename>` comes from. TD-03's key layout (`videos/{videoId}/...`) does not itself preserve the client's original filename, and TD-04's draft-registration decision (single status enum column) does not mention capturing the original filename as a stored field. Without a decided source, the download SI cannot know whether to read this value from a new `Video` entity column (e.g. `originalFilename`), derive it from the video's title, or fall back to a generic name. Explicit choice: decide (via a TD revision to TD-04 or TD-03) whether the original client filename is persisted at draft-creation time and, if so, on which entity/column.

### Dependency Gaps

_None._ — DG-1 is resolved (see `## Resolved Issues`). The bucket/credential-provisioning gap identified above is filed under Missing Decisions (MD-2) rather than here, since resolving it requires a strategic choice (which provisioning mechanism) rather than a missing prior-phase deliverable or undocumented within-phase capability ordering — no other unaddressed prerequisite was found between phase-03's capabilities or from phase-01/phase-02's inherited conventions.

### Inherited Constraint Conflicts

_None._ — TD-09's dual-endpoint model and the new `minio` `compose.yaml` service follow the inherited convention ("Auxiliary local-dev services ... are added to `compose.yaml` as their own service") without contradiction. TD-07 still reaffirms the inherited UUID-PK-as-public-identifier convention. No current-phase TD redefines the inherited error-response shape or bypasses `class-validator`/`@nestjs/throttler` conventions. No contradictions found between phase-03-videos TDs (including the new TD-09 and the revised TD-04/TD-06/TD-08 prose) and `## Inherited Conventions` / `## Inherited Decisions Detail`.

### Unresolved Open Questions

_None._ — All 9 TDs in `## Decisions Index` carry `Status: decided`; no pending TDs. `## UI Inventory` is absent (no UI scope this phase), so there is no `### Open Questions from Inventory` block to ingest.

### UI Coverage Gaps

_None._ — `## UI Inventory` is absent; this phase has no UI scope (`next-frontend/` explicitly out of scope, deferred per `## Non-UI / Deferred Capabilities`). UIG-N is not applicable.

## Resolved Issues

- **IC-1** _(resolved_by phase-03-videos/TD-09)_ — TD-09's dual-endpoint configuration (`STORAGE_INTERNAL_ENDPOINT` for admin/bucket operations, `STORAGE_PUBLIC_ENDPOINT` for the presigning `S3Client`) explicitly resolves the internal-vs-public hostname mismatch that made TD-02/TD-08's presigned URLs unimplementable as originally described, and confirms the `minio` service publishes a host-mapped port for local dev.
- **AMB-1** _(resolved_by phase-03-videos/TD-08)_ — TD-08's revised Recommendation states streaming and download are "two call sites against the same presigned `GetObjectCommand` operation, differing only in the `ResponseContentDisposition` parameter," with the download URL explicitly signed using `ResponseContentDisposition: 'attachment; filename="<original-filename>"'`. The distinct-parameterization question is answered (see MD-3 for a residual, narrower gap this revision surfaces).
- **AMB-2** _(resolved_by phase-03-videos/TD-04)_ — TD-04's revised Recommendation decides the trigger is a client call to a dedicated completion endpoint (`POST /videos/:id/complete-upload`) that verifies object existence via a `HeadObject`-equivalent call before flipping status and enqueueing the job, explicitly ruling out a storage-side webhook/bucket-notification mechanism (see AMB-5 for a residual, narrower gap this revision surfaces around multipart completion).
- **AMB-3** _(resolved_by phase-03-videos/TD-06)_ — TD-06's revised Recommendation decides a fixed 3-second frame offset (`ffmpeg -ss 3 -i <input> -vframes 1 <thumbnail.jpg>`), computed after `ffprobe` reports duration, with an explicit fallback to `0s` when the probed duration is shorter than 3 seconds.
- **MD-1** _(resolved_by phase-03-videos/TD-09)_ — TD-09 ("Object Storage Deployment and Endpoint Configuration") decides MinIO as the storage backend, deployed as a new `compose.yaml` service.
- **DG-1** _(resolved_by phase-03-videos/TD-09)_ — TD-09 decides to add MinIO as a new `compose.yaml` service, closing the gap where object storage was the only piece of "new infrastructure this phase introduces" without a planned compose service (unlike Redis/TD-01 and the worker container/TD-05).

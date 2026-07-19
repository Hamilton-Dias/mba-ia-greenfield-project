---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 6
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-19T19:03:17-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-19T18:55:00-03:00"
issues:
  - id: IC-1
    status: open
    summary: "Presigned direct-to-storage (TD-02/TD-08) unreconciled with Docker Compose internal-DNS networking"
  - id: AMB-1
    status: open
    summary: "TD-08 doesn't address Content-Disposition override needed to force download vs. inline streaming"
  - id: AMB-2
    status: open
    summary: "Draft→processing transition trigger (client confirm vs. worker/event detection) undocumented"
  - id: AMB-3
    status: open
    summary: "Thumbnail frame/timestamp selection strategy unspecified in capability or TD-06"
  - id: MD-1
    status: open
    summary: "No TD decides the object storage backend/vendor (self-hosted MinIO vs. cloud S3-compatible)"
  - id: DG-1
    status: open
    summary: "Object storage compose.yaml service not planned, unlike Redis (TD-01) and worker container (TD-05)"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

- **IC-1** — TD-02 ("Presigned URLs, direct client → storage, multipart for large files") and TD-08 ("Presigned GET URLs, direct client → storage, shared for streaming and download") both require the end user's browser to reach the object storage service directly, over the public internet. Nothing in `## Decisions Detail`, `## Inherited Conventions`, or the Non-UI/Deferred table addresses how this squares with the project's established deployment pattern: `## Inherited Conventions` states "Auxiliary local-dev services ... are added to `compose.yaml` as their own service — the same pattern applies to new infrastructure this phase introduces (Redis for TD-01, the standalone worker container for TD-05)." If object storage follows that same pattern (e.g. a `minio` Compose service reachable by the API/worker via internal DNS like `http://minio:9000`), a presigned URL signed against that internal hostname is not resolvable by an external browser client — the URL embeds the host it was signed for, and S3-style signing does not tolerate a silent host swap without also re-deriving/passing through the signature machinery (or configuring a distinct public endpoint at generation time). Neither TD-02 nor TD-08 states which endpoint (internal vs. public-facing) is used when generating presigned URLs, nor whether a second, externally-mapped port/hostname for the storage service is planned. Explicit choice: (a) TD-02/TD-08 (or a new TD) must specify a dual-endpoint configuration — internal endpoint for the SDK's signing/API calls, distinct public endpoint substituted into the presigned URL host — and (b) `compose.yaml` planning must confirm the storage service publishes a host-reachable port for local dev (and a real public endpoint/CDN in later environments). Until this is decided, TD-02 and TD-08 are not implementable as literally described.

### Ambiguities

- **AMB-1** — TD-08's recommendation frames the presigned GET URL as "shared for streaming and download," justified entirely by `Range`-request support for a scrubbable player. It never addresses the capability bullet "Download do vídeo pelo usuário" as a *distinct* behavior from "Reprodução via streaming" — specifically, forcing a browser to save-as/download (rather than play inline) normally requires the response to carry `Content-Disposition: attachment`, which for S3-compatible presigned GETs means passing a `response-content-disposition` override at URL-generation time (i.e., a *second*, differently-parameterized presigned URL for the same object, not literally the same URL "shared" between the two capabilities). Bundling both capability bullets under one TD/table cell risks hiding that this is two call sites with two different presign parameterizations, not one. Explicit choice: clarify in TD-08 (or a follow-up revision) whether download issues a separately-parameterized presigned URL with `response-content-disposition=attachment`, or whether download is expected to just be "save the streamed response" from the frontend (which would also work, but changes what "download" means as a backend contract vs. a pure frontend action) — needed before this can decompose into a concrete SI.
- **AMB-2** — Capability "Processamento automático do vídeo após upload" and TD-04 (single status enum, draft → automatic processing → terminal) do not specify what event actually triggers the draft→processing transition. Because TD-02 chose direct client → storage upload (the backend is not in the upload's data path), the backend has no inherent visibility into when the upload (especially multipart) actually completes. At least three plausible mechanisms exist and none is decided: (a) the client calls a "complete multipart upload" endpoint on the backend, which itself proxies/confirms completion to storage and then flips status + enqueues the job; (b) the client completes the multipart upload directly against storage, then makes a separate "notify backend upload finished" call; (c) the storage service emits a bucket/object-created event/webhook (e.g., MinIO bucket notifications) that the backend or worker consumes to detect completion and flip status automatically, with no client confirmation call at all. These have materially different failure modes (client crash mid-flow, abandoned uploads, replay/idempotency) and API surface implications. Explicit choice: a TD (or a revision to TD-02/TD-04) must state which of these triggers the transition before the upload/status-lifecycle SIs can be written.
- **AMB-3** — The capability bullet "Geração automática de thumbnail a partir de um frame do vídeo" and TD-06 (tooling: `ffmpeg`/`ffprobe` via `execa`) decide *how* thumbnails are technically extracted but not *which* frame — e.g., a fixed timestamp (1s), a percentage of duration (10%), the first non-black/non-blank frame, or some other seek strategy. This is a concrete parameter an implementer needs (an `ffmpeg -ss <t>` value or equivalent) and is not decided anywhere in `## Decisions Detail`. Explicit choice: decide (or add to TD-06) the frame-selection strategy.

### Missing Decisions

- **MD-1** — No TD decides *which* object storage product/deployment the phase uses (e.g., self-hosted MinIO as a new Docker Compose service vs. a managed S3-compatible provider vs. AWS S3 proper). TD-03 ("Object Storage Bucket/Key Organization") presupposes an S3-compatible API already exists and only decides the bucket/prefix layout within it; TD-02 and TD-08 presuppose presigned-URL support (an S3-compatible feature) without naming the product. Every other new-infra decision this phase makes is paired with an explicit vendor/mechanism choice (TD-01 names BullMQ+Redis; TD-05 names a standalone NestJS worker container) — object storage is the one piece of "new infrastructure this phase introduces" (per `## Inherited Conventions`'s own phrasing) that has no such TD. Explicit choice: run `/research phase-03-videos` (or `/decide`) to add a TD selecting the storage backend and its deployment story (self-hosted MinIO in `compose.yaml`, following the same pattern as Redis/TD-01, is the option most consistent with the rest of this phase's decisions, but it is not yet decided anywhere).
- **MD-1** is the root cause behind **IC-1** and **DG-1** above/below: without a decided storage backend, neither the networking question (IC-1) nor the compose-service provisioning question (DG-1) can be fully closed — resolving MD-1 first is the natural order of operations.

### Dependency Gaps

- **DG-1** — TD-02, TD-03, and TD-08 all assume an S3-compatible object storage service exists and is reachable by the API/worker, but no new compose.yaml service for object storage is planned or referenced anywhere in `context.md`. Contrast with `## Inherited Conventions`'s explicit statement that new infra this phase introduces gets its own compose service, naming only "Redis for TD-01, the standalone worker container for TD-05" — object storage is conspicuously absent from that list despite being a harder prerequisite than either (upload literally cannot happen without it). Neither phase-01 nor phase-02's inherited TDs/conventions provision object storage either, so this is not something already delivered by a prior phase. Explicit choice: once MD-1 is resolved (storage backend chosen), add the corresponding compose.yaml service (e.g. `minio`) to this phase's plan, following the same "new infra as its own service" convention already used for `mailpit` (Phase 02) and planned for Redis (TD-01) and the worker container (TD-05).

### Inherited Constraint Conflicts

_None._ — TD-07 explicitly reaffirms the inherited UUID-PK-as-public-identifier convention (no conflict); no current-phase TD redefines the inherited error-response shape (`{ statusCode, error, message }`) or bypasses `class-validator`/`@nestjs/throttler` conventions. No contradictions found between phase-03-videos TDs and `## Inherited Conventions` / `## Inherited Decisions Detail`.

### Unresolved Open Questions

_None._ — All 8 TDs in `## Decisions Index` carry `Status: decided`; no pending TDs. `## UI Inventory` is absent (no UI scope this phase, consistent with the backend-only nature of the phase per `## Scope`'s "Out of scope" note), so there is no `### Open Questions from Inventory` block to ingest.

### UI Coverage Gaps

_None._ — `## UI Inventory` is absent; this phase has no UI scope (`next-frontend/` explicitly out of scope, deferred per `## Non-UI / Deferred Capabilities`). UIG-N is not applicable.

## Resolved Issues

_No issues resolved yet._

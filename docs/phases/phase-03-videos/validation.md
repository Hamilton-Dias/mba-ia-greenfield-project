---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 1
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-19T22:27:07-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-19T22:23:55-03:00"
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
    status: resolved
    summary: "TD-09 ambiguous on whether the worker (TD-05) actually needs STORAGE_PUBLIC_ENDPOINT/presigning"
    resolved_by: phase-03-videos/TD-09
  - id: AMB-5
    status: resolved
    summary: "TD-04's completion-endpoint trigger doesn't reconcile with TD-02's multipart CompleteMultipartUpload step"
    resolved_by: phase-03-videos/TD-04
  - id: MD-2
    status: resolved
    summary: "No TD decides how the MinIO bucket/root credentials are provisioned/seeded on startup"
    resolved_by: phase-03-videos/TD-09
  - id: MD-3
    status: resolved
    summary: "No TD/entity decision covers where TD-08's download filename parameter is sourced from"
    resolved_by: phase-03-videos/TD-04
  - id: MD-4
    status: open
    summary: "TD-04's 'terminal state' is unnamed; success AND failure post-processing writeback undecided"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._ — IC-1 remains resolved (see `## Resolved Issues`). Re-checked all 9 decided TDs (including the amended TD-04, TD-08, TD-09 prose) against each other and against `## Scope`: TD-09's dual-endpoint model is internally consistent with TD-02/TD-08's direct-client-to-storage design; TD-04's multipart-vs-single-PUT completion split is internally consistent with TD-02's "multipart for large files" decision and with TD-09's internal-endpoint admin `S3Client`; TD-08's filename sourcing is internally consistent with TD-04's persistence decision. No capability bullet requires behavior a decided TD rules out, no two TDs imply mutually exclusive runtime behavior, and no current-phase TD's `Capability:` field cites a bullet absent from `## Scope`. `## UI Inventory` is absent, so the UI↔Scope inconsistency sub-check and the Scope-Subsection orphan sub-check (both conditioned on populated UI Inventory / `Scope: Frontend` TDs) do not apply — all 9 TDs are `Scope: Backend`.

### Ambiguities

_None._ — AMB-4 and AMB-5 are resolved this round (see `## Resolved Issues`). Re-ran Check 2 against every capability bullet and against the newly-amended TD-04/TD-08/TD-09 prose: the amendments added specificity (multipart completion split, endpoint-per-component assignment, bucket/credential provisioning mechanics) rather than introducing new vague phrasing. No capability bullet is newly ambiguous, and no revised TD reopens a boundary question with this phase's neighbors (Fase 02, Fase 04).

### Missing Decisions

- **MD-4** — TD-04's Recommendation names the destination of automatic processing only as an unspecified "terminal state" (`draft → automatic processing → terminal state`) and, in its round-3 revision, thoroughly decides the **draft→processing** trigger (client completion endpoint, `HeadObject` vs. `CompleteMultipartUploadCommand` split) — but nothing in `## Decisions Detail` decides the symmetric **processing→terminal** transition for either outcome:
  - **Success:** no TD states the terminal enum value(s) (e.g., `ready`/`completed`/`published`... whatever is chosen), which component writes the transition (presumably the worker, per TD-05/TD-06, once `ffmpeg`/`ffprobe` finish), or which fields carry the processing output — duration/metadata (the capability's own wording: "extração de duração e metadados") and the generated thumbnail's storage key (TD-09 confirms the worker uploads the thumbnail to storage, but not that it also records the key on the `Video` row).
  - **Failure:** no TD states what the worker does when `ffmpeg`/`ffprobe` fails (non-zero exit, corrupt/unsupported input, timeout) — whether the enum gets a dedicated `error`/`failed` value, whether an error message/reason is persisted (and on which column), and how this interacts with BullMQ's own retry/backoff policy (TD-01 decides BullMQ as the queue technology but not a retry policy for this job, nor whether repeated failure ultimately flips status to error or leaves the video stuck in `processing`).

  This is a genuine new gap surfaced by this round's amendments, not a restatement of the now-closed AMB-2/AMB-5: those covered *draft→processing*; this covers *processing→terminal* (both directions), which the "terminal state" phrase in TD-04 gestures at but never resolves. Without it, the worker's job handler (TD-05/TD-06) has a fully-specified *input* path (fetch source, run ffprobe/ffmpeg, generate thumbnail, upload thumbnail via TD-09's internal-endpoint client) but no specified *output* contract — an implementer would have to invent the terminal enum values and the error-handling behavior rather than read them from a decision. Explicit choice: run `/research phase-03-videos` (or `/decide`) to add a TD (or a revision to TD-04) naming the terminal enum value(s), the entity columns the worker writes on success (duration, metadata, thumbnail key), and the failure-path behavior (error enum value, error-message storage, and whether/how BullMQ retry attempts factor into when the error state is finally written).

### Dependency Gaps

_None._ — DG-1 remains resolved (see `## Resolved Issues`). Re-checked `## Inherited Conventions` against this phase's capabilities: Redis (TD-01), the standalone worker container (TD-05), and MinIO (TD-09) are all planned as `compose.yaml` services per the inherited "auxiliary local-dev services get their own Compose service" convention — no infra prerequisite is left unaddressed. Within-phase ordering is also sound: TD-09's "ensure bucket exists on API bootstrap" runs automatically ahead of any upload, so no manual provisioning step is silently assumed. The processing→terminal writeback gap identified above (MD-4) is a missing *strategic decision*, not a missing *prerequisite/deliverable* or an undocumented *ordering* dependency, so it is filed under Missing Decisions rather than here.

### Inherited Constraint Conflicts

_None._ — TD-09's dual-endpoint model and bucket/credential provisioning follow the inherited "auxiliary services added to `compose.yaml`" convention without contradiction. TD-04's multipart-completion split (API performs `CompleteMultipartUploadCommand` server-side via TD-09's internal-endpoint admin client) does not conflict with any inherited convention. TD-07 still reaffirms the inherited UUID-PK-as-public-identifier convention. No current-phase TD (including the round-3 amendments to TD-04/TD-08/TD-09) redefines the inherited error-response shape (phase-02 TD-07) or bypasses `class-validator`/`@nestjs/throttler` conventions. No contradictions found.

### Unresolved Open Questions

_None._ — All 9 TDs in `## Decisions Index` carry `Status: decided`; no pending TDs. `## UI Inventory` is absent (no UI scope this phase), so there is no `### Open Questions from Inventory` block to ingest.

### UI Coverage Gaps

_None._ — `## UI Inventory` is absent; this phase has no UI scope (`next-frontend/` explicitly out of scope, deferred per `## Non-UI / Deferred Capabilities`). UIG-N is not applicable. (Cross-slice checks — `CC-N`/`MC-cross-N` — are also not applicable: this is a monolithic phase with exactly one phase-scope decisions doc for NN=3, so Check 8 is suppressed by construction; the `## Cross-slice Advisories` / `## Capability Consistency` sections are omitted per the skill's suppression rule.)

## Resolved Issues

_(preserved from prior revisions — audit trail; 10 issues resolved across rounds 1–3)_

- **IC-1** _(resolved_by phase-03-videos/TD-09)_ — TD-09's dual-endpoint configuration (`STORAGE_INTERNAL_ENDPOINT` for admin/bucket operations, `STORAGE_PUBLIC_ENDPOINT` for the presigning `S3Client`) explicitly resolves the internal-vs-public hostname mismatch that made TD-02/TD-08's presigned URLs unimplementable as originally described, and confirms the `minio` service publishes a host-mapped port for local dev.
- **AMB-1** _(resolved_by phase-03-videos/TD-08)_ — TD-08's revised Recommendation states streaming and download are "two call sites against the same presigned `GetObjectCommand` operation, differing only in the `ResponseContentDisposition` parameter," with the download URL explicitly signed using `ResponseContentDisposition: 'attachment; filename="<original-filename>"'`.
- **AMB-2** _(resolved_by phase-03-videos/TD-04)_ — TD-04's revised Recommendation decides the trigger is a client call to a dedicated completion endpoint (`POST /videos/:id/complete-upload`) that verifies object existence via a `HeadObject`-equivalent call before flipping status and enqueueing the job, explicitly ruling out a storage-side webhook/bucket-notification mechanism.
- **AMB-3** _(resolved_by phase-03-videos/TD-06)_ — TD-06's revised Recommendation decides a fixed 3-second frame offset (`ffmpeg -ss 3 -i <input> -vframes 1 <thumbnail.jpg>`), computed after `ffprobe` reports duration, with an explicit fallback to `0s` when the probed duration is shorter than 3 seconds.
- **MD-1** _(resolved_by phase-03-videos/TD-09)_ — TD-09 ("Object Storage Deployment and Endpoint Configuration") decides MinIO as the storage backend, deployed as a new `compose.yaml` service.
- **DG-1** _(resolved_by phase-03-videos/TD-09)_ — TD-09 decides to add MinIO as a new `compose.yaml` service, closing the gap where object storage was the only piece of "new infrastructure this phase introduces" without a planned compose service (unlike Redis/TD-01 and the worker container/TD-05).
- **AMB-4** _(resolved_by phase-03-videos/TD-09)_ — TD-09's revised Recommendation explicitly decides "only the API constructs the presigning `S3Client` and needs `STORAGE_PUBLIC_ENDPOINT`... The worker (TD-05) never issues a presigned URL to anyone... using only `STORAGE_INTERNAL_ENDPOINT` via an admin-style `S3Client`," and states `STORAGE_PUBLIC_ENDPOINT` is a required env var for the API process only — the worker's Joi schema needs only `STORAGE_INTERNAL_ENDPOINT` plus shared credentials/bucket name.
- **AMB-5** _(resolved_by phase-03-videos/TD-04)_ — TD-04's revised Recommendation decides the multipart path explicitly: the client collects part ETags and calls `/complete-upload`, and the API itself performs `CompleteMultipartUploadCommand` server-side via TD-09's internal-endpoint admin `S3Client` (a successful response is itself the existence proof, no separate `HeadObject` needed); the single-`PUT` path instead uses a `HeadObject` check. Both differ in what "verify completion" means but end the same way (status flip + enqueue).
- **MD-2** _(resolved_by phase-03-videos/TD-09)_ — TD-09's revised Recommendation decides both halves of provisioning: (a) credentials sourced once via `compose.yaml`'s `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`, consumed by API/worker as `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY`; (b) the bucket is created via an idempotent "ensure bucket exists" check (`HeadBucket` → `CreateBucket` on not-found) performed by the API on application bootstrap, mirroring how the app already manages schema via TypeORM migrations rather than an external init script.
- **MD-3** _(resolved_by phase-03-videos/TD-04)_ — TD-04's revised Recommendation decides the client supplies `originalFilename` at draft pre-registration time and the API persists it on the `videos` row; TD-08 cross-references the same field as the source read by the download-variant presigned GET's `ResponseContentDisposition`.

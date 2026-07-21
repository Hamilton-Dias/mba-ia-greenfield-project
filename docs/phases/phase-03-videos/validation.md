---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-19T22:43:21-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-19T22:41:52-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-19T22:59:24-03:00"
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
    status: resolved
    summary: "TD-04's 'terminal state' is unnamed; success AND failure post-processing writeback undecided"
    resolved_by: phase-03-videos/TD-04
  - id: MD-5
    status: resolved
    summary: "No TD decides Video→Channel FK or upload/completion-endpoint ownership authorization"
    resolved_by: phase-03-videos/TD-04
  - id: MD-6
    status: resolved
    summary: "No TD decides whether streaming/download is gated by video processing status"
    resolved_by: phase-03-videos/TD-08
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._ — Re-ran Check 1 against all 9 decided TDs and all 9 capability bullets, with specific attention to the TD-04 ↔ TD-02 boundary flagged for this round: TD-04's new "Ownership and authorization" clause (channelId resolved server-side from `req.user`, no client-supplied `channelId`, `JwtAuthGuard` on both `POST /videos` and `POST /videos/:id/complete-upload`) does **not** need to be mirrored into TD-02. TD-02's Recommendation is scoped exclusively to the upload *transport protocol* (presigned URLs vs. TUS, multipart for large files) — it never names an endpoint, a request payload, or an auth concern; endpoint-level ownership/authorization is TD-04's domain, and which component is technically capable of signing the presigned URL is TD-09's domain ("only the API constructs the presigning `S3Client`... for both TD-02's upload handshake and TD-08's streaming/download URLs"). These are three orthogonal concerns (protocol / ownership / signing-component) that compose without overlap: by the time TD-02's multipart mechanics run, TD-04's endpoint has already resolved and authorized the channel. No revision to TD-02 is needed or implied. Also re-checked TD-04's ownership clause against TD-08's streaming/download endpoints: TD-08 intentionally has no ownership/JWT check (streaming/download aren't gated by channel ownership, only by `status='ready'`), which is consistent by design — Phase 03 has no visibility/privacy concept yet (public/unlisted is explicitly Fase 04's job per `## Scope`'s Out of scope note), so a `ready` video being universally streamable is the correct interim behavior, not an omission. No capability bullet requires behavior a decided TD rules out, no two TDs imply mutually exclusive runtime behavior, and no current-phase TD's `Capability:` field cites a bullet absent from `## Scope`. `## UI Inventory` is absent, so the UI↔Scope inconsistency sub-check and the Scope-Subsection orphan sub-check do not apply — all 9 TDs are `Scope: Backend`.

### Ambiguities

_None._ — Re-ran Check 2 against every capability bullet. All 9 are specific enough to decompose into concrete SIs: named enum values (`draft`/`processing`/`ready`/`error`), named fields (`channelId`, `originalFilename`, `duration`, `thumbnailKey`, `error_message`), named endpoints (`POST /videos`, `POST /videos/:id/complete-upload`), named retry policy (`attempts: 3` + exponential backoff), named frame offset (3s, with 0s fallback), and a named identifier strategy (UUID PK reuse). No boundary with Fase 02 or Fase 04 is left ambiguous — the Out of scope note explicitly enumerates every capability pushed to Fase 04/05/06.

### Missing Decisions

_None._ — Re-ran the capability-coverage gate bullet-by-bullet against `## Decisions Detail`, checking for *real* (not nominal) coverage, not just a table-row match:

- Storage service (videos+thumbnails) → TD-03 (bucket/key layout) + TD-09 (deployment, dual-endpoint, bucket/credential provisioning) — both TDs contain concrete mechanics, not just a label.
- Background job queue → TD-01 (BullMQ, retry/backoff config) + TD-05 (worker runtime, container isolation) — concrete.
- Upload up to 10GB → TD-02 (presigned multipart, per-upload-cost-independent-of-size rationale) — concrete, directly answers the "sem impacto na performance" requirement.
- Draft pre-registration → TD-04 (trigger is a client call to a dedicated endpoint; payload includes `originalFilename`; channel resolved from JWT) — concrete.
- Automatic processing (duration/metadata) → TD-04 (terminal-transition writes) + TD-05 (worker process) + TD-06 (`ffprobe` invocation, JSON parsing via `execa`) — concrete.
- Thumbnail generation → TD-06 (fixed 3s offset, 0s fallback for short clips) — concrete.
- Unique URL → TD-07 (UUID PK reuse, precedent-matched to `User`/`Channel`) — concrete.
- Streaming → TD-08 (presigned `GetObjectCommand`, no `ResponseContentDisposition` override, `status='ready'` gate, native `Range` support from the storage service) — concrete.
- Download → TD-08 (same call site, `ResponseContentDisposition: attachment` variant, filename sourced from TD-04's `originalFilename` column) — concrete.

All 9 bullets have real, mechanically-specific coverage — none is a nominal match (a TD title that merely echoes the bullet without deciding anything). MD-5 and MD-6 (below) are both confirmed closed this round with substantive resolutions, not placeholder acknowledgments. No new "decision without TD" gap surfaced: the object-storage error-response format is already inherited from Fase 02's Domain Exception Filter (not a new decision this phase owes); the shared-types/contract-sync check (Decisão #29) does not fire because `## UI Inventory` is absent (`ui_in_scope: false` by construction — this phase is backend-only).

### Dependency Gaps

_None._ — Re-checked `## Inherited Conventions` against this phase's capabilities. Redis (TD-01), the standalone worker container (TD-05), and MinIO (TD-09) are all planned as `compose.yaml` services per the inherited "auxiliary local-dev services get their own Compose service" convention. The `Channel` entity and `JwtAuthGuard` that TD-04's ownership clause depends on both already exist from Fase 02 — no prerequisite is undelivered. Within-phase ordering: TD-09's "ensure bucket exists on API bootstrap" runs before any upload can be initiated (the API must be up and serving `POST /videos` for a job to ever reach the worker), so no bucket-existence race with the worker container is possible by construction of the causal chain (upload → API-bootstrapped → job enqueued → worker consumes) — this was considered and is not a gap. MD-5 and MD-6 from the prior round are missing *strategic decisions*, not missing *prerequisites*, and both are now resolved (see below), so nothing remains here.

### Inherited Constraint Conflicts

_None._ — TD-04's new ownership clause reuses the exact inherited `JwtAuthGuard` from Fase 02 (no new guard introduced, as TD-04 states explicitly) and mirrors the exact 1:1 `Channel`↔`User` FK shape already established in Fase 02's schema — no redefinition, no conflict. TD-08's status-gating clause (404 for any non-`ready` status) does not bypass the inherited Domain Exception Filter — it's a domain-level "not found" outcome, consistent with how the filter already maps domain exceptions to HTTP responses. TD-09's dual-endpoint model and bucket/credential provisioning follow the inherited "auxiliary services added to `compose.yaml`" convention without contradiction. TD-07 still reaffirms the inherited UUID-PK-as-public-identifier convention. No current-phase TD redefines the inherited error-response shape or bypasses `class-validator`/`@nestjs/throttler` conventions.

### Unresolved Open Questions

_None._ — All 9 TDs in `## Decisions Index` carry `Status: decided`; zero pending TDs remain. `## UI Inventory` is absent (no UI scope this phase), so there is no `### Open Questions from Inventory` block to ingest.

### UI Coverage Gaps

_Not applicable — skipped per instruction._ `## UI Inventory` is absent; this phase has no UI scope (`next-frontend/` explicitly out of scope, deferred per `## Non-UI / Deferred Capabilities`). Cross-slice checks (`CC-N`/`MC-cross-N`, Check 8) are likewise not applicable: this is a monolithic phase with exactly one phase-scope decisions doc for NN=3 (confirmed via `Grep -l '^scope_type: phase$'` ∩ `related_phases` containing `3` → single match), so Check 8 is suppressed by construction; the `## Cross-slice Advisories` / `## Capability Consistency` sections are omitted per the skill's suppression rule.

## Resolved Issues

_(preserved from prior revisions — audit trail; 13 issues resolved across rounds 1–5)_

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
- **MD-4** _(resolved_by phase-03-videos/TD-04)_ — TD-04's revised Recommendation now fully specifies the processing→terminal transition, symmetric to the already-resolved draft→processing trigger: **success** — the worker performs one atomic update landing `status='ready'`, `duration` (ffprobe), and `thumbnailKey` (the just-uploaded thumbnail's storage key) together, so no partially-written state is visible; **failure** — the worker catches any ffprobe/ffmpeg/storage exception, writes `status='error'` plus a new nullable `error_message` column in the same kind of single update, then re-throws so BullMQ's retry policy (explicitly configured as `attempts: 3` + exponential backoff, per TD-01) governs re-runs; each retry re-sets `status='processing'` at attempt start and resolves to `ready`/`error` at attempt end; after the 3rd failure the `error` write stands permanently, with manual re-enqueue explicitly deferred to a future phase's operational tooling.
- **MD-5** _(resolved_by phase-03-videos/TD-04)_ — TD-04's revised Recommendation adds an "Ownership and authorization" clause: the `videos` table carries a `channelId` FK (mirroring `Channel`'s existing 1:1 FK toward `User`); neither `POST /videos` nor `POST /videos/:id/complete-upload` accept a client-supplied `channelId` — both resolve the target channel automatically from `req.user` (JWT guard), eliminating the IDOR risk by construction. Both endpoints require the existing `JwtAuthGuard` from Fase 02; no new guard is introduced.
- **MD-6** _(resolved_by phase-03-videos/TD-08)_ — TD-08's revised Recommendation adds a "Status gating" clause: the streaming and download endpoints only succeed when `video.status === 'ready'`; any other status (`draft`, `processing`, or `error`) causes the endpoint to return `404 Not Found` rather than issuing a presigned URL, keeping a single consistent "not found" semantics across every non-ready state.

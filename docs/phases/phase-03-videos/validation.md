---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 2
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-19T22:34:58-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-19T22:31:57-03:00"
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
    status: open
    summary: "No TD decides Video→Channel FK or upload/completion-endpoint ownership authorization"
  - id: MD-6
    status: open
    summary: "No TD decides whether streaming/download is gated by video processing status"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._ — IC-1 remains resolved (see `## Resolved Issues`). Re-checked all 9 decided TDs against each other and against `## Scope`, including TD-04's newly-added "Processing→terminal transition" clause: the worker's success write (`status='ready'` + `duration` + `thumbnailKey`, one atomic update) and failure write (`status='error'` + `error_message`, then re-throw for BullMQ's 3-attempts exponential-backoff retry per TD-01) do not contradict any other TD — TD-05/TD-06 already establish the worker as the component running ffprobe/ffmpeg and TD-09 already establishes the worker's internal-endpoint client for the thumbnail upload the success path references. No capability bullet requires behavior a decided TD rules out, no two TDs imply mutually exclusive runtime behavior, and no current-phase TD's `Capability:` field cites a bullet absent from `## Scope`. `## UI Inventory` is absent, so the UI↔Scope inconsistency sub-check and the Scope-Subsection orphan sub-check (both conditioned on populated UI Inventory / `Scope: Frontend` TDs) do not apply — all 9 TDs are `Scope: Backend`.

### Ambiguities

_None._ — Re-ran Check 2 against every capability bullet and against TD-04's new clause: the terminal-transition writeup is specific (named enum values `ready`/`error`, named fields `duration`/`thumbnailKey`/`error_message`, named retry policy `attempts: 3` + exponential backoff), not vague. No capability bullet is newly ambiguous, and no revised TD reopens a boundary question with this phase's neighbors (Fase 02, Fase 04). The two gaps found in this round's critical pass (below) are filed as Missing Decisions, not Ambiguities — they are not "vaguely worded capabilities" but capabilities with zero TD coverage of a required strategic choice.

### Missing Decisions

_MD-4 is resolved this round — see `## Resolved Issues`. Two new gaps surfaced by this round's whole-document critical pass (run specifically to check the phase is slice-ready), both concerning coverage this project's own capability list and `project-plan.md` vision imply but no TD in `## Decisions Detail` actually decides:_

- **MD-5** — No TD decides the `Video` entity's ownership association or any authorization gate on the upload-initiation/pre-registration and completion endpoints. TD-04 decides the draft-creation payload (`originalFilename`) and the `complete-upload` endpoint's verification mechanics (`HeadObject` vs. `CompleteMultipartUploadCommand`), but nothing in `## Decisions Detail` establishes that a `Video` row carries a `channelId` (or `userId`) foreign key, nor that `POST /videos` (draft pre-registration) or `POST /videos/:id/complete-upload` verify the authenticated caller owns the target channel before creating/mutating the row. The platform is multi-tenant by construction (`project-plan.md` § Visão Geral: "cada usuário possui um canal"; Fase 04's channel management panel lists a channel's own videos, which requires the FK to already exist), so this relationship must be established somewhere, and Phase 03 is the phase that first creates the `Video` row. Without it, any authenticated user could currently call `complete-upload` against another user's draft video ID, or pre-register a video under a channel they don't own — an implementer would have to invent both the FK and the ownership check rather than read them from a decision. Not a restatement of any resolved issue: MD-3 covered where the download filename is sourced from, not who may create/complete a video. Explicit choice: run `/research phase-03-videos` (or `/decide`) to add a TD (or revise TD-04) deciding (a) the `Video` → `Channel` FK column, and (b) the authorization check — presumably reusing the existing JWT guard convention from Fase 02 (`## Inherited Conventions`) — that the pre-registration/completion endpoints enforce ownership of the target channel.

- **MD-6** — No TD decides whether streaming/download (TD-08) is gated by the video's processing `status`. TD-08 decides the presigned-GET mechanism (shared `GetObjectCommand`, differing only by `ResponseContentDisposition`) but never states whether the API checks `video.status === 'ready'` before issuing either presigned URL. Because TD-03/TD-09 place the original file at its permanent key from the moment upload completes — before processing even starts — and TD-06 never re-encodes the file, the object is physically retrievable the instant `draft → processing` fires. As currently decided, a video stuck in `processing` (still being probed/thumbnailed) or terminally `error` (per TD-04's new failure path) is just as streamable/downloadable via a presigned GET as one that reached `ready`, risking exposure of an unprocessed or broken video (no confirmed duration/thumbnail, or a file `ffprobe`/`ffmpeg` already rejected) through the very capabilities this phase delivers ("Reprodução via streaming", "Download do vídeo"). This is distinct from the (correctly out-of-scope) Fase 04 public/unlisted visibility flow — that concept doesn't exist yet in this phase; this is purely about the `draft`/`processing`/`ready`/`error` enum TD-04 itself introduces, which is squarely in this phase's own scope. Explicit choice: run `/research phase-03-videos` (or `/decide`) to add a TD (or revise TD-08) deciding whether the streaming/download endpoint(s) reject (404/409-equivalent) any `status != 'ready'` video before signing a GET, or whether exposure is intentionally unrestricted this phase (and if so, document why that's acceptable given TD-04's own error/processing states).

### Dependency Gaps

_None._ — DG-1 remains resolved (see `## Resolved Issues`). Re-checked `## Inherited Conventions` against this phase's capabilities: Redis (TD-01), the standalone worker container (TD-05), and MinIO (TD-09) are all planned as `compose.yaml` services per the inherited "auxiliary local-dev services get their own Compose service" convention — no infra prerequisite is left unaddressed. Within-phase ordering is also sound: TD-09's "ensure bucket exists on API bootstrap" runs automatically ahead of any upload, and TD-04's terminal-transition clause now fully specifies the worker's output contract, so no ordering is silently assumed. MD-5 and MD-6 above are missing *strategic decisions*, not missing *prerequisites/deliverables* or undocumented *ordering* — the `Channel` entity itself already exists (Fase 02) and the presigned-GET mechanism is already built (TD-08); what's missing is a decision layered on top of both, so both are filed under Missing Decisions rather than here.

### Inherited Constraint Conflicts

_None._ — TD-09's dual-endpoint model and bucket/credential provisioning follow the inherited "auxiliary services added to `compose.yaml`" convention without contradiction. TD-04's full terminal-transition clause (success and failure writeback) does not conflict with any inherited convention — it does not bypass the inherited Domain Exception Filter (phase-02/TD-07) since the worker itself is not an HTTP surface (TD-05); the `complete-upload` endpoint that IS an HTTP surface still throws through the standard filter for its `HeadObject`/`CompleteMultipartUploadCommand` failure cases per the existing convention. TD-07 still reaffirms the inherited UUID-PK-as-public-identifier convention. No current-phase TD redefines the inherited error-response shape or bypasses `class-validator`/`@nestjs/throttler` conventions. No contradictions found.

### Unresolved Open Questions

_None._ — All 9 TDs in `## Decisions Index` carry `Status: decided`; no pending TDs. `## UI Inventory` is absent (no UI scope this phase), so there is no `### Open Questions from Inventory` block to ingest.

### UI Coverage Gaps

_None._ — `## UI Inventory` is absent; this phase has no UI scope (`next-frontend/` explicitly out of scope, deferred per `## Non-UI / Deferred Capabilities`). UIG-N is not applicable and was skipped this round per instruction (phase has no UI scope). Cross-slice checks (`CC-N`/`MC-cross-N`, Check 8) are also not applicable: this is a monolithic phase with exactly one phase-scope decisions doc for NN=3, so Check 8 is suppressed by construction; the `## Cross-slice Advisories` / `## Capability Consistency` sections are omitted per the skill's suppression rule.

## Resolved Issues

_(preserved from prior revisions — audit trail; 11 issues resolved across rounds 1–4)_

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

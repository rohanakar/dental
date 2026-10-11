# Day 5: Adapt and persist (occlusion/contact adaptation, self-intersection check, project zip, backups)

Status: **done** (2026-10-11).

## Goal

- The crown adapts to the antagonist and the neighbours. When the clearance target conflicts with the minimum
  thickness, it stops and reports "insufficient reduction".
- An exported crown is checked for self-intersections.
- A design can be taken out of the browser as one local project file, with or without the backend.
- The production stack backs itself up every night.

## Scope

In:
1. **Adaptation is stored as settings, not displacements.** `TemplateCrown.adapt = { occlusion?: { clearanceMm },
   mesial?: { targetMm }, distal?: { targetMm } }`. The crown stays derived: fit → thickness → adapt occlusion →
   adapt contacts → re-enforce thickness → conflict report. Undo/redo and parameter edits just work, and the document
   stays small (no displacement blobs).
   - Commands: `adaptOcclusion {fdi, clearanceMm}` and `setContact {fdi, side, targetMm}` (existing LLM tools) set
     these and mark `adapt` done.
   - "Reset adaptation" = `setCrown` without `adapt`.
2. **Adapt geometry** (`geometry/adapt.ts`).
   - *Occlusion.* Applies to occlusal-facing shell vertices (n·occlusal > 0.2, upper half). The signed clearance to
     the antagonist is measured along +occlusal; the displacement along occlusal is (clearance − target). Only
     vertices within 0.5 mm of contact are raised; all penetrating ones are reduced.
   - *Contacts.* The same along ±mesial for proximal-facing vertices (|n·mesial| > 0.5, 30–90% height). It works
     against the prep jaw minus the prep band (as the proximal map).
   - The **displacement field** is smoothed over the shell (Laplacian, ring fixed), never the positions, so cusps
     keep their shape.
   - *Conflicts.* After re-enforcing thickness, vertices still closer than target − 0.02 mm are reported with their
     count, the minimum clearance and centroid positions: `insufficient reduction` for occlusion, `contact too tight`
     for contacts.
3. **Self-intersection** (`geometry/selfIntersect.ts`). BVH triangle–triangle test excluding triangles that share a
   vertex. `validation.selfIntersections`; `printable = ok && selfIntersections === 0`. Finalize shows it.
4. **Local project zip** (`io/projectZip.ts`, fflate). `<ref>.dcad.zip` = `manifest.json`
   (`dcad.project@1`, app version, created) + `design.json` (DesignDocument) + `scans/<role>.<ext>` (original
   bytes).
   - Import verifies the sha256 of every scan against the document and opens it in offline mode.
   - The scene controller keeps each scan's source `Blob` by sha256 so it can be exported.
   - Toolbar: "Download project" and "Open project".
5. **Nightly backups** (`infra/backup/`): a `backup` service in the production compose.
   - It runs `pg_dump -Fc` plus a tarball of the blob volume every night at `BACKUP_HOUR` (UTC) into
     `${BACKUP_DIR:-/var/backups/dcad}` on the host, keeping `BACKUP_KEEP_DAYS` (default 14).
   - `infra/backup/restore.sh` restores both. The README covers the off-box copy (follow-up: S3 target).
6. **Pipeline:** the case runs with `adapt.occlusion = params.occlusalClearanceMm` and contacts =
   `params.proximalContactMm`. Checks: the crown is printable (no self-intersections), and clearances are at or above
   target − 0.02 mm unless a conflict is reported.

Out: sculpt (Day 6 stretch); presigned uploads; version-history UI.

## Design notes

- `designCrown` input gains `adapt?: CrownAdapt` (the same shape as the schema). The result gains `adapt?: {
  occlusion?: AdaptReport; mesial?: AdaptReport; distal?: AdaptReport }`, where `AdaptReport = { movedVertices,
  maxMoveMm, minClearanceMm, conflict?: { kind, vertices, minClearanceMm, at: V3 } }`.
- The Adapt step UI has occlusion and contact targets (default from params), "Adapt occlusion" and "Adapt contacts"
  buttons (dispatch), "Reset adaptation", conflict warnings with a "show" marker overlay, and the occlusion and
  proximal colour maps preselected.
- Self-intersection runs in the worker as part of validation (about 20k triangles; budget < 50 ms).

## Verification plan

- **Unit:**
  - Adapting to a flat antagonist plane gives every occlusal vertex clearance ≥ target − 0.02.
  - Raising toward a plane slightly above makes contact.
  - A plane closer than the min thickness allows gives a conflict with the vertex count.
  - Cusp shape is preserved (the displacement is smooth).
  - Contacts: same against a vertical plane.
  - Self-intersection: a closed cube 0, two interpenetrating cubes merged > 0, the synthetic crown 0.
  - Zip round-trip: same document and bytes; sha mismatch is rejected.
  - Reducer: adapt commands, step status, reset via `setCrown`.
- **Pipeline:** synthetic-36 with adaptation. Occlusion min clearance ≥ target − 0.02 or a reported conflict;
  printable.
- **Browser:**
  - Propose → Adapt occlusion → the occlusion map has no red, and undo works.
  - Download the project → open the project offline → the same crown.
- **Backup:** run the backup service once against a local Postgres in Docker, restore into a fresh database, and the
  row counts match.

## Work split

- Fork A (geometry): `adapt.ts`, `selfIntersect.ts`, `crown.ts` integration + tests.
- Fork B (persistence/infra): `io/projectZip.ts` + tests, scene source-blob retention, the Download/Open project UI,
  `infra/backup/` + compose service + README section + a local Docker drill.
- Main session: schema + reducer commands, worker/crownTool/Adapt step UI, Finalize printable status, pipeline, E2E.

## Implementation summary

### What was built
- **Schema** (`packages/shared/src/design.ts`): `CrownAdapt` and `TemplateCrown.adapt`.
- **Reducer** (`apps/web/src/design/reducer.ts`):
  - `adaptOcclusion` and `setContact` set the targets and mark `adapt` done.
  - Pose edits keep the targets and mark `adapt` stale.
  - Reset = `setCrown` without `adapt`.
- **Geometry** (fork A):
  - `geometry/adapt.ts`: `adaptOcclusion`, `adaptContacts`, `adaptToTarget`, `measureClearances`, `findConflict`.
    It works on a smoothed displacement field (damped Jacobi fill plus capped smoothing) with the ring and band
    fixed.
  - `geometry/selfIntersect.ts`: `countSelfIntersections` (BVH, robust tri–tri test, adjacent pairs skipped).
  - `crown.ts` order: fit → thickness → occlusion → contacts → thickness → conflicts → validation and
    self-intersections → maps. `validation` gains `selfIntersections` and `printable`; the result gains `adapt`
    reports.
- **Persistence and infra** (fork B):
  - `io/projectZip.ts` (`dcad.project@1`: manifest, design.json, original scan bytes).
    - Import verifies the sha256 of every scan, strips `fileId` and opens offline.
    - `sceneController.sourceFor`/`loadLocalScans` keep each scan's source bytes.
  - `session.downloadProject`/`openProject`: it reads and verifies the file before clearing the workspace.
    `ui/session/ProjectControls.tsx` puts both in the toolbar.
  - `infra/backup/backup.sh` + `restore.sh` and a `backup` service in `infra/docker-compose.yml`:
    - nightly `pg_dump -Fc` + blob tarball into `${BACKUP_DIR:-/var/backups/dcad}`, 14-day retention;
    - `.partial` writes; `BACKUP_RUN_ON_START`, `BACKUP_ONCE`;
    - an `infra/README.md` section.
- **Main session:**
  - Worker/`crownTool` pass `adapt`; red conflict markers are drawn at the conflict centroids.
  - `ui/steps/AdaptStep.tsx`: targets, Adapt buttons, reports, conflict text, reset, occlusion map preselected.
  - Finalize shows self-intersections and printable, and warns when the crown isn't printable.
  - Pipeline: `crown.printable` and `crown.adapt.*` checks; `selfIntersections` and `adapt` are in `metrics.json`.

### Deviations from the spec
- **Raising works on the whole selection.** Raising every vertex within 0.5 mm flattened domes. Instead, when
  nothing is within the target, active vertices are lifted by `(min − target) × falloff(clearance)`, so the closest
  point lands exactly on the target. Penetrations are still reduced per vertex.
- **Self-intersection lives in `crown.ts`.** It is merged into `CrownValidation` there; `meshValidate.ts` is
  unchanged.
- **Backups stay on the VM's disk.** Copying them off the VM is a manual step documented in the README; an S3 target
  is a follow-up.

### Found and fixed during this day
- **Secrets in `.env.example`.** The working copy had real values for `POSTGRES_PASSWORD` and `AUTH_SECRET`; fork B
  flagged it. I blanked them (the same values are in the gitignored `.env`) and scanned all committable files for the
  values: none.
- **User-reported `Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"`.**
  - Real cause: `password authentication failed`. The local `.env` `DATABASE_URL` still had the literal
    `<POSTGRES_PASSWORD>` placeholder.
  - Fixed: substituted the URL-encoded password, and `pnpm dev:api` now applies the migrations and listens.
  - `.env.example` now explains the placeholder.

### Verification
- **Unit:** `pnpm test`: 6 shared, 163 web (2 skipped), 18 API unit, 1 pipeline. `pnpm typecheck` and the web
  build are clean.
  - Geometry: 107 tests.
    - Adapt: a dome against penetrating, raised and too-low planes, plus contact walls.
    - Self-intersect: cube, overlapping cubes, side-by-side cubes.
    - Crown 36/46: printable, fully adapted, and a forced conflict that reports `insufficient reduction` on 421
      vertices.
  - Zip: 4 tests. Session: +1.
- **Pipeline:** 1/1 cases.
  - Printable (0 self-intersections).
  - Adaptation reaches its targets: occlusion −0.501 → 0.050, mesial 0.327 → 0.020, distal 0.404 → 0.020, with no
    conflicts.
  - Self-intersection 19–21 ms for 20k triangles; crown step with adaptation and maps 509 ms on the 1M-triangle scan.
- **Browser** (`tools/e2e/offline-design.mjs`):
  - Adapt occlusion: −1.76 → 0.050 mm (after the earlier gizmo lift). Adapt mesial contact: 0.278 → 0.020 mm.
    Printable, 0 self-intersections, `adapt` done.
  - Download project → open it in a fresh page (offline) → same crown volume, 371.745 → 371.745 mm³.
  - Gizmo, nudge, maps and export still pass.
- **Backup drill** (plain Docker, everything removed afterwards):
  - Restored 1234/1234 rows with matching checksums and identical blob files.
  - A second restore over existing data works.
  - Pruning removed 40-day-old files.
  - An unreachable database exits 1 and leaves no `.partial` files.

### Follow-ups
- Off-box backup target (S3-compatible) and an automated restore drill on the VM.
- Sculpt and a displacement layer (`TemplateCrown.deltas`) if needed after the Day 6 agent work.

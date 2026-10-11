# Day 2: Case setup, tooth frame, live-wire margin, insertion axis

Status: **done** (2026-10-11).

## Goal

A user can take a case from "scans loaded" to "margin and insertion axis accepted" for one posterior tooth, in the
browser. The same algorithms run headlessly over golden cases. The web app also talks to the backend now: sign in,
open or create a case, upload its scans, and save and load design versions. That piece slipped from Day 1.

## Scope

In:
1. **Design document store.** A reducer applies the document commands with step invalidation. Snapshot undo/redo
   (a basic form is pulled forward from Day 4, since it is cheap with immutable snapshots).
2. **Case setup.** FDI tooth chart (posterior teeth selectable) and material presets → per-tooth `DesignParams`.
3. **Tooth frame.** Click the prep → occlusal, mesial and buccal directions plus mesial/distal neighbour contacts
   (auto). Override: click a contact point manually, or flip mesial/distal.
4. **Live-wire margin.** Click anchors on the prep jaw. The path from the last anchor to the cursor is shown live.
   Click the first anchor (or press Enter) to close. Drag anchors, smooth, undo the last anchor.
5. **Insertion axis.** Least-undercut search in a 25° cone around the occlusal direction. Alternative: take the axis
   from the current view direction. Undercut colour map with a legend. Warn when the margin is in an undercut.
6. **Colour-map material + legend** (pulled forward from Day 3, because the undercut map needs it).
7. **Headless pipeline runner** over golden cases (synthetic case generated, real ones when supplied):
   import → frame → margin from scripted anchors → prep region → axis → undercut → `metrics.json`.
8. **Web↔API.** Sign up / sign in / sign out, case list, create a case from the setup, open a case (latest version
   + its scans), upload scans (gzip + sha256), save a version (optimistic concurrency). Offline local mode stays
   available.

Out (later days): intaglio, crown, export (Day 3); fit, thickness, gizmo, step re-run automation (Day 4); auto
margin proposer, orchestrator (Day 6); local project zip (Day 5).

## Design

### Shared schema changes (`packages/shared`)
- `addScan` **replaces** any scan with the same role (one scan per role).
- New document command `removeScan { role }`.
- No other schema changes. `ToothFrame` already carries `mesialContact`/`distalContact`. `MarginLine` keeps
  `anchors` (control points) and `points` (dense, resampled ~0.2 mm, closed, implicitly wraps).

### Document store (`apps/web/src/design`)
- `reducer.ts`: `applyCommand(doc, cmd): DesignDocument`. It is pure and throws `CommandError` on invalid targets.
  - `setCaseSetup`: syncs `teeth[]` with the setup. It keeps existing teeth, adds new ones with
    `MATERIAL_PRESETS[material]` params, and drops removed ones. A material change resets params (`params` and
    downstream go stale). `steps.setup = done`.
  - `addScan` / `removeScan`: the tooth's `scans` step is done when its jaw scan exists. A scan whose sha256 changed
    marks `frame` and everything downstream stale.
  - `setFrame|setMargin|setAxis|setParams|setCrown`: set the field, mark the step done, and mark downstream steps
    that were `done` as `stale` (`downstreamSteps`).
  - Clinical commands throw `not supported yet` (Day 4/6).
- `store.ts` (zustand): `doc`, `past`/`future` (cap 100), `dispatch(cmd | cmd[])` (each validated with
  `Command.parse`; a batch is one undo entry), `undo`, `redo`, `load(doc, version)`, `markSaved(version)`, `dirty`,
  `activeFdi`, `activeStep`.
- `newDocument(caseId, setup?)`. The default setup is tooth 36, zirconia (matches the synthetic demo prep).

### Geometry (pure TS, `apps/web/src/geometry`)
All functions take typed arrays (positions xyz, BVH-ordered `indices`, unit vertex `normals`). Vertex ids are shared
by the worker and the main thread (the BVH reorders the index only, never vertices).

| File | Exports |
|---|---|
| `raycast.ts` | `RayCaster` interface (`first`, `all`, `closestPoint`) + `bvhRayCaster(positions, indices, bvh)` adapter over three-mesh-bvh. Algorithms depend only on the interface. |
| `surface.ts` | `buildVertexAdjacency` (CSR), `smoothVertexNormals`, `signedCurvature` (1/mm, convex > 0, from (nᵥ−nᵤ)·(pᵥ−pᵤ)/‖pᵥ−pᵤ‖² over the 1-ring on smoothed normals), `smoothScalar`, `analyzeSurface` |
| `livewire.ts` | `liveWireWeight(curvature, κ0)`, `dijkstraTree(positions, graph, weight, source, radiusMm)` (binary heap, bounded by Euclidean radius), `pathFromTree`, `traceClosedLoop(…, anchorVertices)`, `resampleClosedPolyline`, `smoothClosedPolyline(points, iterations, project?)`, `polylineLength` |
| `toothFrame.ts` | `estimateToothFrame({jaw, antagonist?, seed, fdi, ray})`, `findNeighbourContacts(...)` |
| `prepRegion.ts` | `prepRegion({positions, graph, loopVertices, seedVertex, maxRadiusMm})` → vertex mask + face mask + `closed`; `dilateMask` |
| `axis.ts` | `searchInsertionAxis({positions, indices, faceMask, center, coneDeg})`, `undercutDepths(...)`, `marginUndercut(...)` |

Algorithms:
- **Live-wire edge cost** = length × f(κ̄), where κ̄ is the mean of the two endpoint curvatures. For κ̄ > 0,
  f = max(0.02, 1/(1+(κ̄/κ0)²)). For κ̄ ≤ 0, f = 1 + min(2, −κ̄/κ0). κ0 = 1 mm⁻¹. Convex ridges (the margin) are
  cheap. Concave chamfer floors and the sulcus cost extra. Dijkstra runs once per anchor click, bounded to 12 mm.
  The predecessor tree goes to the main thread, so the preview path to the cursor is a local lookup with no worker
  round trip.
- **Tooth frame.**
  - *occlusal*: the whole-jaw PCA least-variance axis, if it is within 25° of the mean vertex normal within 10 mm of
    the seed. Otherwise that local mean normal. On an open scan, normals point out of the teeth, toward the
    antagonist.
  - *mesial-distal line*: the major axis of the 2D covariance of points within 12 mm of the seed (horizontally) and no
    lower than 1.5 mm below the prep top. That is crown tissue only, which excludes the palate and gingiva.
  - *signs*: buccal points away from the arch centroid. Mesial follows from FDI quadrant handedness: quadrants 1 and 3
    use `mesial = occlusal × buccal`, quadrants 2 and 4 use `mesial = buccal × occlusal` (scans are never mirrored).
  - *origin*: the prep top under the seed (ray cast down along −occlusal).
- **Neighbour contacts.** A fan of rays (heights −2…+2 mm, buccal offsets ±1.5 mm) runs from the prep top along
  ±mesial. Take the first front-facing hit at least 0.3 mm away and no more than 2.5 mm below the prep top, with
  the minimum distance over the fan. No hit within 10 mm means no neighbour on that side.
- **Prep region.** BFS from a vertex inside the loop, which the closed vertex chain cannot cross on a 2-manifold.
  The result is `closed: false` if the fill escapes 1.5× the loop radius.
- **Axis search.** Minimize Σ area·max(0, −n_f·d) over prep faces, plus a small tie-break toward the occlusal
  direction. The search uses Fibonacci samples on a 25° cap, then a local refinement at 0.25°.
- **Undercut map.** For each prep-region vertex, a ray goes along +axis. The distance to the first prep face hit is
  the blockout depth (0 means visible).
- **Margin in undercut.** The same ray test from each margin point.

### Synthetic prep (`geometry/synthetic.ts`)
The Day 1 stump had no convex margin ridge. Its only convex edge was the occlusal line angle. The new profile has a
flat top, a tapered axial wall, a chamfer ledge, and a **convex margin edge** where the ledge meets the root surface,
which then drops into the sulcus. That is the case the live-wire must handle: snap to the ridge, not the chamfer
floor. `syntheticPrepMargin()` returns the analytic margin ring and `syntheticPrepSeed()` a point on the prep top, for
tests and the golden case.

### Worker (`apps/web/src/workers`)
The worker **retains** a copy of each imported scan: positions, normals, BVH-ordered index and BVH, keyed by sha256.
It transfers copies to the main thread. New Comlink methods:
- `estimateFrame`
- `analyzeSurface` (cached)
- `liveWireTree` → `Int32Array` predecessors
- `traceLoop` (anchors → dense margin)
- `smoothMargin`
- `axisAnalysis` (search + undercut scalars + margin undercut)
- `releaseScan`

### Viewer (`apps/web/src/engine`)
- `overlays.ts`: fat polylines (Line2), point markers, arrows. Drawn over surfaces with polygon offset on the
  meshes, so lines on the surface don't z-fight.
- Colour maps: a per-vertex `scalar` attribute, a 1D LUT texture and a range uniform in the surface material.
  Values below −1e29 mean "no value" (left untinted). Legend: React `ColorLegend`.
- Interaction hooks: `setInteraction({onClick, onHover, onDragStart, onDrag, onDragEnd})`. A click is less than
  5 px of movement. The handler can claim a drag (anchor dragging), which disables the camera. Also
  `raycast(x, y, {objectIds})` and `project(point)`.

### UI (`apps/web/src/ui`)
The left panel holds the steps (Setup → Scans → Frame → Margin → Axis; later steps shown disabled) and an active-step
panel. Keyboard: Ctrl/Cmd+Z undo, Shift+Ctrl/Cmd+Z redo, Backspace removes the last anchor, Enter closes the margin,
Esc cancels the tool. Undo applies to document commands, not to in-progress anchors.

### Web↔API (`apps/web/src/api`, `state/caseSession.ts`)
- `api/client.ts`: typed fetch over `apiUrl()` with zod-parsed responses and `ApiError` → `ApiRequestError`.
- `api/auth.ts`: Better Auth client (email/password).
- On scan import inside a case: gzip with `CompressionStream` (buffered to a Blob; streaming request bodies need
  HTTP/2), then `POST /files` with the sha256 from the worker, then `addScan` with the `fileId`. Demo scans upload
  their generated PLY bytes.
- Open case: `GET /cases/:id` + `GET /versions/latest` (404 → new document from the setup). Each scan with a
  `fileId` is fetched (the browser un-gzips via `Content-Encoding`) and imported; the worker re-verifies the sha256.
- Save: `POST /versions` with `parentVersion`. A 409 tells the user to reload.
- Offline mode: everything works without the API; nothing is persisted.

### Pipeline runner (`tools/pipeline-runner`)
- Golden case: `data/golden/<id>/case.json` with `{ id, fdi, material, scans: {upper?, lower?}, seed, marginAnchors,
  expect? }`, plus scan files.
- `--synthetic` writes `data/golden/synthetic-36/`.
- `pnpm --filter @dcad/pipeline-runner run [--cases data/golden] [--out out/pipeline]` writes
  `<out>/<id>/metrics.json` (timings, frame, contacts, margin length/closure/deviation, axis angle, undercut area,
  margin undercut count, checks). It exits non-zero if any check fails.

## Verification plan

- Unit (vitest):
  - Reducer: invalidation, setup sync, undo/redo batches.
  - Adjacency and curvature signs: a sphere is positive, a concave bowl negative.
  - Live-wire: path continuity, and on the synthetic prep the traced margin follows the analytic ridge (mean
    deviation < 0.15 mm).
  - Frame on the synthetic arch: occlusal ≈ +z, mesial ≈ toward the arch front, buccal outward, both contacts found.
  - Prep region closed; axis within 5° of +z on the symmetric prep.
  - A tilted bulbous prep gives a positive undercut and a margin-undercut warning.
- Pipeline runner on `synthetic-36`: all checks pass.
- Web↔API: run the API against the test Postgres. Sign up, create a case, import the demo, upload, save, reload,
  reopen. The scans and margin come back.
- `pnpm typecheck`, `pnpm test`, and `test:infra` all green.

## Work split

- Geometry fork: `geometry/{raycast,surface,livewire,toothFrame,prepRegion,axis}.ts` + tests, the `synthetic.ts`
  prep profile, and `tools/pipeline-runner`.
- Main session: shared schema changes, design store, worker wiring, viewer overlays and colour maps, step UI, web↔API.

## Implementation summary

### What was built

**Shared:** `removeScan` command; `addScan` documented as replace-by-role (`packages/shared/src/commands.ts`).

**Document store:** `apps/web/src/design/`.
- `document.ts`: `newDocument`, default setup 36/zirconia.
- `reducer.ts`: pure `applyCommand` with setup sync, scan-step derivation and downstream invalidation.
- `store.ts`: zustand store with snapshot undo/redo (cap 100), batches, dirty tracking, `load`/`markSaved`.

**Scene ↔ document:** `state/sceneController.ts`.
- The viewer shows `doc.scans`, so undo and redo of scan changes work. Geometry is cached by sha256.
- A `ScanPersistence` seam uploads after import; `loadScans` re-imports a case's files and verifies them.

**Geometry:** `apps/web/src/geometry/`, written by the geometry fork.
- Files: `raycast.ts` (`RayCaster` + `bvhRayCaster`), `surface.ts` (CSR adjacency, smoothed normals, signed curvature), `livewire.ts`, `toothFrame.ts`, `prepRegion.ts`, `axis.ts`.
- The synthetic FDI 36 prep now has a real convex margin edge, plus `syntheticPrepMargin`/`syntheticPrepSeed`.

**Worker:** `workers/`.
- `scanRegistry.ts` keeps worker-side copies of each scan and its BVH.
- `geometry.worker.ts` adds `analyzeSurface`, `estimateFrame`, `liveWireTree`, `traceMargin`, `smoothMargin`, `axisAnalysis` and `releaseScan`. Message types are in `analysisTypes.ts`.

**Viewer:** `engine/`.
- `overlays.ts`: Line2 polylines, screen-space markers, arrows.
- `colormap.ts` + `materials.ts`: vec2 `scalar` attribute (value, hasValue), LUT and polygon offset.
- `Viewer.ts`: `setInteraction` (click / hover / claimed drag), `raycast(..., {objectIds})`, `project`, `focus`, `viewDirection`, `setObjectScalars`.

**Tools:** `apps/web/src/tools/`.
- `controller.ts` routes pointer input per step and draws frame, margin and axis overlays.
- `frameTool.ts`: click the prep, flip mesial/distal, pick or clear contacts.
- `marginTool.ts`: live-wire clicks, live preview from the transferred predecessor tree, close, drag anchors, smooth, Backspace/Enter/Esc.
- `axisTool.ts`: least undercut, from view, 1° tilts, undercut map, margin-undercut markers.

**UI:** `ui/`.
- `StepNav`; step panels in `ui/steps/` (Setup with `ToothChart`, Scans, Frame, Margin, Axis); `ToolStatus`; `ColorLegend`.
- Undo/redo in the toolbar and on Ctrl/Cmd+Z.

**Web↔API:** written by the API fork.
- `api/client.ts`, `api/auth.ts`, `state/session.ts`.
- `ui/session/*`: `SessionGate` wraps the editor; `SessionControls` sits in the toolbar with Save (Ctrl/Cmd+S), Cases and Sign out.

**Pipeline runner:** `tools/pipeline-runner`. Run it with `pnpm pipeline --synthetic`.

**Browser E2E:** `tools/e2e`, pulled forward from Day 7.
- `offline-design.mjs` and `online-case.mjs` drive the real app in headless Chrome through the dev-only `window.__dcad` hook (`src/debug.ts`).

### Deviations from the spec
- **Worker keeps a second copy of every scan.** The scan, its BVH and its analysis caches stay in the worker, which
  roughly doubles scan memory (about 40 MB per 1M-triangle jaw). That keeps all analysis off the main thread. The
  main thread only does picking and path lookups in the transferred predecessor tree.
- **Fork API changes.**
  - `pred[source] = source` (not −1), so the transferred array is self-describing.
  - `bvhRayCaster(bvh)` takes the BVH only.
  - The prep-region leak bound is 1.5× loop radius **+ 3 mm**, because tall preps falsely leaked.
  - The runner writes only `metrics.json`.
- **UX additions that came out of browser testing.**
  - The antagonist hides in the frame, margin and axis steps; otherwise the upper jaw covers the prep in occlusal view.
  - The margin step zooms onto the prep from occlusal; the axis step zooms in obliquely from buccal.
  - The axis is proposed only when entering the step. Re-proposing on every change would immediately undo an undo
    and clear redo.
- **Day 1 bug fixed.** Cursor-centric orbit (`setOrbitPoint`) left a camera focal offset that `setLookAt` never
  cleared. After any click, standard views and focus were shifted, by about 20 mm in the test case.
  `Viewer.lookAt` now resets it. Projection switching deliberately keeps it.
- **Pulled forward.** Colour-map material and legend (Day 3), snapshot undo/redo (Day 4), browser E2E scripts (Day 7).
- **Contacts.** Contact points are stored in the frame (`setFrame`). There is no separate contact command.

### Verification
- **Unit tests.** `pnpm test`: 6 shared, 64 web (2 skipped: API e2e gated on `WEB_API_E2E_URL`), 18 API unit and
  1 pipeline-runner test pass. `pnpm --filter @dcad/api test:infra`: 36/36 against Postgres + SeaweedFS.
  `pnpm typecheck` and `pnpm --filter @dcad/web build` are clean.
- **Geometry.**
  - Live-wire on the synthetic prep: mean deviation 0.097 mm / max 0.209 mm from 7 anchors. With 4 anchors it is
    0.077 mm, against 0.305 mm for a plain geodesic, so the curvature term works.
  - A bulbous stump is flagged as undercut. A 20°-tilted 12°-taper stump gets an axis 6–12° off occlusal with no
    undercut.
- **Pipeline** (`pnpm pipeline --synthetic`, 1M-triangle arch): 11/11 checks pass.
  - Margin mean deviation 0.055 mm, max 0.129 mm. Axis 0°, no undercut.
  - Timings: analyzeSurface 105 ms, bounded Dijkstra tree 28–39 ms, frame 24 ms, margin 18 ms, prep region 7 ms,
    axis search 65 ms, undercut map 31 ms.
- **Browser, offline** (`tools/e2e/offline-design.mjs`, headless Chrome):
  - The demo loads in about 0.8 s.
  - The frame from one click: occlusal·z = 0.9999, mesial toward the arch front, both contacts about 4.5 mm away.
  - 8 clicks + close give a 27.9 mm margin (156 points), 0.062 mm mean / 0.196 mm max from the analytic ridge.
  - An anchor drag re-traces the margin; undo restores it exactly.
  - The auto axis has 0 undercut. A 30° buccal tilt gives 0.44 mm² and 3.28 mm deepest, shown in the map.
  - No console errors apart from the expected 502 from the missing API.
- **Browser, online** (`tools/e2e/online-case.mjs`, local API + Postgres 17):
  - Sign-up, new case, and demo scans uploaded (gzip, file ids set).
  - Frame, margin and axis, then Ctrl+S → "Saved v1".
  - Reload → the session persists. Reopening the case re-downloads both scans (gzip `Content-Encoding` through the
    Vite proxy) and verifies their sha256. The document is identical.
  - A second tab's save makes the first tab's save fail with a clear conflict message.
  - The only console errors are the expected 401 (pre-sign-in), 404 (no version yet) and 409.

### Follow-ups
- Real golden cases are needed (Day 0 data). The frame heuristics are only verified on the synthetic full arch: not on
  quadrant scans or upper-jaw preps, and live-wire is unverified on real scan noise.
- Click-to-insert an anchor on an existing margin; an automatic margin proposer (Day 6).
- Sessions: case rename/delete, organization switching. Offline work cannot be moved into a case.
- E2E uses SwiftShader software GL (slow for 1.3M triangles, hence the camera "settle" waits). Day 7 converts it to
  `@playwright/test`.

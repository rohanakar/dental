# Plain-language check messages, and the colour maps in the help sheet

Status: **done** (2026-10-26).

## Goal

A follow-up of `specs/2026-10-26-new-user-journey.md`. Auto-design's draft review shows each step's QA checks and its
rationale (the failing checks always, the rest behind "Show the checks"). Many read as engineering notes: "Frame axes
are orthonormal (0, limit 0)", "The margin ridge was found on most radial profiles", "Occlusal from the arch and local
normals, mesial from the arch tangent and FDI handedness". Rewrite them in words a dental technician or a chairside
clinician understands, and add the colour maps to the help sheet's terms.

## Scope

**In** (the user trimmed the scope to "only what is needed"):
- Every user-visible QA check `message` of auto-design: `apps/web/src/ai/qa.ts`, `apps/web/src/ai/proposers.ts`,
  `apps/web/src/geometry/wingUnit.ts` (`wingChecks`), `apps/web/src/geometry/inlayChecks.ts`, and the two proposer
  errors that surface as a check message and name "the proposer".
- Every rationale in `apps/web/src/ai/proposers.ts`.
- `apps/web/src/ui/HelpSheet.tsx`: one line per colour map the user can pick (the four crown maps of
  `tools/crownLegend.ts`, and the undercut map on Insertion axis).
- The landing capture of the opened check list (`apps/web/src/landing/assets/auto-design.webp`), whose alt text quotes
  the old messages: re-shot, with its size, alt text, caption and provenance updated.

**Out:**
- Check ids: unchanged (tests, browser scripts, proposal events and agent tools use them).
- Geometry and worker warnings appended to a rationale (frame, crown, bridge, connector design), and every other copy.
- The pipeline runner's own checks (a developer tool's console output).
- The pass condition of any check (two values only change unit, see Design).

## Design

**Rules.** Sentence case. Clinical terms stay (margin, prep, insertion axis, undercut, antagonist, contact, connector,
pontic, Ti-base, veneering space). No maths or implementation words (orthonormal, radial profiles, ridge, normals,
handedness, arch tangent, genus, RMS, inliers, 95th percentile, vertices, ICP, template ids). `checkValue` appends
"(value, limit x)", so a message with a value names what it measures and its unit, written as ", in mm" or ", in
degrees" rather than "(mm)", so two brackets never follow each other.

**Two values change unit, not their gate.** A unitless value cannot be put in plain words:
- `frame.orthonormal` (and `.<fdi>`) reports the largest error from a right angle between the frame's directions in
  degrees instead of a dot product; it still passes below a dot of 0.001 (shown as limit 0.057°).
- `frame.handedness.<fdi>` reports the angle between the pontic's mesial direction and its neighbour in degrees
  instead of a cosine; it still passes above a cosine of 0.5 (limit 60°).

**Examples** (the full set is in the code):

| Check | Before | After |
|---|---|---|
| `frame.orthonormal` | Frame axes are orthonormal (0, limit 0) | Frame directions at right angles, largest error in degrees (0, limit 0.06) |
| `margin.ridge` | The margin ridge was found on most radial profiles (1, limit 0.75) | The margin edge shows clearly around the prep: share of the way round (1, limit 0.75) |
| `crown.printable` | No self-intersections (0, limit 0) | Places where the surface crosses itself (0, limit 0) |
| `bridge.union.genus` | The merged bridge has no through-holes (genus 0) | Holes through the merged bridge: none expected (0, limit 0) |
| `implant.fit.rms` | Scan-body fit RMS (µm) (0.8, limit 50) | Scan body match: average distance to the scan, in µm (0.8, limit 50) |
| Frame rationale | Occlusal from the arch and local normals, mesial from the arch tangent and FDI handedness. | The biting direction comes from the jaw and the teeth around the click; mesial runs along the arch toward the midline. |

**Help sheet.** Five terms after "Colour maps", titled as the map picker and legend title them: Occlusal clearance,
Proximal clearance, Material thickness, Unmillable (tool radius), Undercut (blockout depth).

## Verification plan

- `pnpm typecheck`, `pnpm test`, `pnpm --filter @dcad/web build`.
- **Tests:** none added or changed. Wording is not tested (CLAUDE.md), and no unit test, runner test or browser script
  matches a changed message (grepped: `apps/web/src/**/*.test.ts`, `tools/pipeline-runner`, `tools/e2e/*.mjs`). The
  suite stays at 111 (99 pass, 12 skipped without infrastructure).
- **Browser scripts:** `first-run`, plus the scripts that run the proposers whose messages or values change:
  `ai-bridge` (pontic frames), `ai-implant`, `ai-maryland`, `ai-framework`.
- **Landing capture:** `tools/e2e/landing-shots.mjs`, then `cwebp -lossless` on `out/landing/auto-design.png` only.

## Implementation summary

Every auto-design check message and rationale now reads in a technician's words. Ids and pass conditions are
unchanged. Two values are now in degrees.

**What was built, and where**
- `apps/web/src/ai/qa.ts`: every gate's messages. These are also the Finalize detail lines (`ui/steps/readiness.ts`,
  `restorations.ts`) and the agent's `failedChecks`, which now read the same. The adapt gate names the side
  ("Occlusion", "Mesial contact") instead of the raw key.
- `apps/web/src/ai/proposers.ts`:
  - the frame, pontic-frame and divergence checks;
  - every rationale;
  - the two errors that named "the proposer".
  - The frame and pontic checks share `orthoCheck` (degrees from a right angle). The scan-body rationale shows the
    registration's reason only when no fit ran; otherwise it points to the failed checks instead of "fit RMS 0.060 mm
    > 0.05 mm". Template ids are gone from the crown and inlay rationales. The cutback rationale names the material
    ("CoCr", not `cocr`) and starts with a capital.
- `apps/web/src/geometry/wingUnit.ts` (`wingChecks`) and `apps/web/src/geometry/inlayChecks.ts`: the wing and inlay
  checks.
- `apps/web/src/ui/HelpSheet.tsx`: five colour-map terms (18 terms now).
- Landing: `auto-design.webp` re-shot and converted with `cwebp -lossless`, now 626 × 674 (was 626 × 570; the plain
  wording wraps onto more lines). `apps/web/index.html` has the new height, alt text and caption, and
  `auto-design.webp.json` names the basis (9a5be07 plus this working tree).

**Deviations from the spec**
- **Readout of two values:** `frame.orthonormal` shows "(0, limit 0.06)": the limit is 0.057°, and the review rounds to
  two decimals.
- **Messages without a unit change:** the connector-design failures (`geometry/connectors.ts`) and the seating and
  pontic-base messages were already plain. Only their "(mm)" endings became ", in mm".

**Verification**
- `pnpm typecheck` clean. `pnpm test`: 111 tests (99 pass, 12 skipped without infrastructure), unchanged.
  `pnpm --filter @dcad/web build` passes (its chunk-size warning predates this task).
- No test, runner test or browser script matched a changed string, so no assertion changed.
- Fixtures were generated in the worktree's own `data/` (8/8 runner cases pass).
- **Browser scripts** (dev server on :5311), every one passes:

  | Script | Checks passed |
  |---|---|
  | `first-run` | 24 |
  | `ai-bridge` | 16 |
  | `ai-implant` | 13 |
  | `ai-maryland` | 7 |
  | `ai-framework` | 6 |

  These match `specs/2026-10-26-one-look.md`. That spec's 14, 8 and 7 also counted the closing "ALL PASSED" line.
  - The new values read as intended: `frame.handedness.36` = 45.2° and `frame.handedness.12` = 51° (limit 60), and
    `frame.orthonormal` = 0°.
  - The demo run gives the same gate values as before (18 checks, all passed).

**Follow-ups**
- Geometry warnings appended to rationales still carry some engineering words, for example "not star-shaped", "envelope
  rays", "genus" in the union failures, and the scan-body failures shown in the implant panel. They are other copy,
  outside this task.
- The crown rationale says "sized to … the margin" for implant crowns too, as before.

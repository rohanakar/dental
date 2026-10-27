# Tooth frames ready for both jaws, and for implant crowns

Status: **done** (2026-10-26, finished and merged 2026-10-27).

## Goal

The two follow-ups of [2026-10-26-auto-frames.md](2026-10-26-auto-frames.md):
1. **Both jaws.** Today `tools/autoFrames.ts` frames only the active tooth's jaw. A case with teeth in both jaws gets
   the other jaw's frames only once one of its teeth becomes active.
2. **Implant crowns.** An implant crown is framed by a click on its scan body. A "scan body found" pass could frame
   it the same way.

## Scope

**In**
- On Tooth frame, every crown-prep tooth on every loaded jaw is framed from its paired prep, still in one undo step.
- Scan bodies found on a jaw scan (`geometry/prepFinder.ts`, same worker call and cache as the preps). They are
  paired with the case's implant teeth in arch order (all-or-nothing, as `prepFor` pairs preps). They are framed
  in the same run, with `estimateFrame` seeded at the scan-body top and `prep: false`, as for a click
  (`frameTool.ts`). The Implant position step then matches the scan body from the frame origin, as after a click.
- **Precision first.** The pass ships only if it finds no scan body on any non-implant golden case and every scan
  body on the implant scans. Otherwise only part 1 ships, and the measurements are reported.

**Out**
- No ring and no click warning for scan bodies: the click flow stays as it is.
- Maryland wing and inlay or onlay teeth stay click-framed.

## Design

### Both jaws (`tools/prepRing.ts`, `tools/autoFrames.ts`)
- `jawFinding(jaw)`: the finding of one loaded jaw scan (its antagonist as context), with the case's crown-prep
  teeth and implant teeth on that jaw. The first call per scan starts the worker. `activeFinding()` is built on it.
- `autoFrames()` collects seeds over every loaded jaw that has crown-prep or implant teeth. It waits until every one
  of those jaws has its finding (or failed), so all of them go out in one dispatch. Bridges are completed per jaw
  (pontics laid out once all abutments are framed), as before.
- Each tooth is still tried once per jaw scan (`sha:fdi`).

### Scan bodies (`findPreps` → `PrepFinding.scanBodies`)
For every crest peak (step 3 of the prep finder):
1. **Top centre:** rays down the occlusal on a 0.25 mm grid within 2.5 mm. The points within 0.5 mm of the
   highest are averaged into the centre, three times (a mean shift onto the top).
2. **Flat top:** a plane fitted to the samples within 1.2 mm of the centre. Its RMS residual is small, and its normal
   is within 30° of the occlusal.
3. **A tall round wall:** 24 radial profiles cast along the top's normal. Each finds its edge, where the surface
   first falls 0.5 mm below the plane. The edges lie on a circle: the median radius is 1.4–3.5 mm and the spread is
   small. At least 20 profiles drop 2 mm or more within 0.6 mm past their edge.
4. **Spacing:** a top within 3 mm of a scan body already found is dropped.

The thresholds are set from the measurements below. A scan body is never also a prep, because it has no ledge.

## Verification plan
- **Measure first** (a one-off script, not committed). Run the detector on every golden case scan and on the implant
  fixture. For each scan record the scan bodies found, missed and false, the top error against the true poses, and
  the closest non-scan-body peak on each gate.
- **Tests:** at most +1, in `apps/web/src/geometry/prepFinder.test.ts`: "finds the scan bodies on an implant scan,
  and none on preps or cavities". The passing case is a synthetic implant scan. The failing cases are the bridge
  and cavity arches the file already builds.
- **Browser scripts:** `first-run`, `bridge` (its auto part), `implant` and `ai-implant`. `implant.mjs`'s bridge part
  gains one check with auto frames on: 35 and 37 are framed on their scan bodies and pontic 36 is placed, in one
  undo step.
- `pnpm typecheck`, `pnpm test`, `pnpm --filter @dcad/web build`.

## Implementation summary

**What was built** (branch `worktree-agent-a2ef73ceee8f1261d`, by an agent on 2026-10-26; finished and merged on
2026-10-27):
- **Both jaws** (`tools/prepRing.ts` `jawFinding`, `tools/autoFrames.ts`):
  - every loaded jaw with crown-prep or implant teeth is searched;
  - all frames go out in one undo step once every jaw's finding is in.
- **Scan bodies** (`geometry/prepFinder.ts` `scanBodies`, `scanBodyFor`): top centre, flat top, a tall round wall,
  spacing. Paired with the case's implant teeth in arch order, all or nothing. Framed with `prep: false`, as for a
  click.

**Measured:**
- **On the branch:** every scan body was found on 2 golden or fixture scans and 4 generated variants (top error
  ≤ 0.06 mm), and none was found on the 25 other scans.
- **On 2026-10-27:** none was found on the 12 real, implant-free Teeth3DS+ jaws (local only;
  `tools/pipeline-runner/src/natural/prepFinderOnNatural.ts`).

**Verification:**
- `pnpm typecheck` clean. `pnpm test` (with the next two specs' work): 124 tests (112 pass, 12 skipped). That is +1
  here: `prepFinder.test.ts`, scan bodies found on an implant scan and none on preps or cavities.
- `pnpm --filter @dcad/web build`.
- Browser scripts: see `2026-10-26-frames-from-case-setup.md`, which changes the same flow (frames on scan load).

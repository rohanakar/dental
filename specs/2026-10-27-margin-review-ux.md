# Margin review UX: see where the line is doubtful, and fix it in a few keystrokes

Status: **done** (2026-10-27).

## Goal

The user (2026-10-27), on the list of UX improvements from the natural-margin research (`ux.md`) and the competitor
review (`scout.md`): "Yes, then complete the UX improvements". A technician should:
- confirm a good margin in seconds;
- go straight to the doubtful parts;
- fix them without redrawing the whole line.

## Scope

**In** (each for both line kinds, a prep's finish line and a natural tooth's gum line, unless noted):
1. **Local edits.**
   - **Drag:** dragging a point re-traces only the line between its two neighbours, and the rest of the line stays
     as it is. Today the whole loop is re-traced through the anchors, which throws away an automatic line's detail.
   - **Insert:** clicking on the line adds a point there, without changing the line.
   - **Delete:** Delete or Backspace on a hovered point removes it and re-traces between its neighbours.
2. **Confidence colouring and jump-to-worst.**
   - The line is coloured green, amber or red by a scan-only test: is it on the crease it should follow (concave for a
     gum line, convex for a finish line), with no stronger crease within 1.5 mm across it?
   - "Next doubtful part" (N, Shift+N for the previous one) flies the camera to each red stretch, framed obliquely so
     the cervical area shows.
3. **One offset for the whole line.** Lower and Raise move every point 0.1 mm along the tooth axis, back onto the
   scan ([ and ]). As in exocad's +/- keys and Medit's slider.
4. **A keyboard flow:**
   - Enter on a closed margin goes to the next step;
   - N and Shift+N jump between doubtful parts;
   - [ and ] lower and raise the line;
   - Delete removes a point;
   - Esc cancels.

   All of these are listed in the help sheet.
5. **A cross-section under the cursor.**
   - In the Margin step, a small panel shows the scan's profile through the point under the cursor, across the line,
     with the margin's own position marked. It's how exocad lets a technician judge a finish line.
   - On by default; a checkbox turns it off.
6. **Scribble correction (gum lines).**
   - "Mark tooth" and "Mark gum": strokes on the scan become extra seeds for the gum-line method
     (`geometry/naturalMargin.ts`), which solves again.
   - The marks add up until cleared.
7. **A demo jaw with real gum.** The demo's synthetic scans get gum over the tooth bases and papillae between the
   teeth, so natural teeth have a realistic gum line.
   - The 36 prep keeps an exposed finish line: the gum stays below it.
   - Scanner-like colour.

**Out:**
- Learned confidence.
- Per-sector undo (one undo step per edit, as today).
- A colour term in the gum-line method.

## Design

**Local edits** (`geometry/marginEdit.ts`):
- `replaceArc(points, from, to, via, path)` replaces the stretch between `from` and `to` that passes `via` (the old
  point), and keeps the rest. Drag and delete use it with the live-wire path through the neighbours.
- **Worker** `traceOpen(sha, waypoints, line)`: an open live-wire path through the waypoints, with the line kind's
  weight.
- **Insert** (`insertAnchor`) adds the anchor at its place along the line, and the points don't change.

**Doubt** (`geometry/marginDoubt.ts`, worker `marginDoubt`):
- **Sampling:** the line is sampled every 0.5 mm.
- **At each sample:**
  - march the scan ±1.5 mm across the line (projected back onto the surface every 0.05 mm);
  - take the profile's curvature over ±0.15 mm;
  - "on the crease": the crease strength is at least 0.15 at the line;
  - "off": the strongest crease within ±1.5 mm is more than 0.25 mm from the line.
- **Levels:** green (on), amber (weak: not on a strong crease, but none stronger nearby) and red (off).
- **Parts:** runs of red samples, ordered by strength.

These are the research's UX rule (`specs/research/2026-10-27-natural-margin/ux.md`). It found 81–91% of off sectors,
and flagged about twice as much as needed: good enough to order the stops, not to skip review.

**Offset:** worker `offsetMargin(sha, points, anchors, occlusal, mm)` moves each point by `mm` along the occlusal
direction, to the nearest scan point within 1.5 mm.

**Cross-section:**
- **Worker** `crossSection(sha, centre, up, across, halfMm)`:
  - triangles near the centre, from a per-scan 2 mm grid, are cut by the plane through `centre` spanned by `up` (the
    tooth axis) and `across` (outward from the axis);
  - it returns 2D segments in mm.
- **Panel** (`ui/steps/MarginSection.tsx`): an SVG of the segments, the cursor point, and the margin's crossing of
  the plane.

**Scribbles:**
- `NaturalMarginInput.seeds?: { tooth: V3[]; gum: V3[] }`: each mark's patch vertices within 0.4 mm are fixed at 1
  (tooth) or 0 (gum).
- **Store:** `toolStore.scribbles` (per tooth).
- **Tool:** a brush mode in `tools/marginTool.ts`: a drag paints, and the release solves again.

**Demo jaw** (`DEMO_SCAN`, worker `demoScan`):
- `gingiva: { coverMm, papillaMm }` chosen so that the 36 prep's finish line stays above the gum (checked against the
  prep profile's margin height);
- `labels` are not needed.

## Verification plan

- **Tests** (+3):
  1. `geometry/marginEdit.test.ts`:
     - dragging a point changes the line only between its neighbours;
     - inserting a point leaves the line as it is;
     - a 0.3 mm raise moves the line about 0.3 mm up the tooth.
  2. `geometry/marginDoubt.test.ts`: on a synthetic natural tooth's gum line, the true line has no red part, and a
     section pushed 1.2 mm up the tooth is flagged (pass and fail).
  3. In `geometry/naturalMargin.test.ts`: tooth marks on the gum just outside one sector move the line there, and
     not elsewhere.
- **Benchmark:** the doubt rule's recall and precision against true per-point error, on the development real teeth.
- **Checks:** `pnpm typecheck`, `pnpm test`, `pnpm --filter @dcad/web build`.
- **Browser:**
  - each tool scripted on the demo: colouring and N, insert, drag, delete, raise and lower, Enter, the section
    panel, marks;
  - `first-run`, `ai-bridge`, `bridge` and `crown-move` (a known legend flake on main);
  - one-click on the 36 prep still passes on the new demo jaw.

## Implementation summary

**What was built, and where.**
1. **Local edits:**
   - `geometry/marginEdit.ts` `replaceArc`, `insertAnchor` and `offsetOnSurface`;
   - `geometry/livewire.ts` `traceOpenPath`;
   - worker `traceOpen` and `offsetPoints`.
   - In `tools/marginTool.ts`:
     - dragging a point re-traces only between its neighbours, and a press without a move changes nothing;
     - a click on the line adds a point;
     - Delete or Backspace removes the hovered point, which is highlighted.
2. **Confidence:**
   - `geometry/marginDoubt.ts` (worker `marginDoubt`) gives each point a level (on, faint, off) and lists the off
     parts, worst first.
   - The line is drawn in green, amber and red (per-vertex colours in `engine/overlays.ts` `setPolyline`, drawn by
     `tools/controller.ts`).
   - The Margin step shows the legend and "N doubtful parts" with "Next doubtful part". N or Shift+N flies the camera
     to each part, obliquely, and says where the stronger edge lies.
3. **Offset:** Lower and Raise buttons, and the [ and ] keys, move the whole line 0.1 mm up or down the tooth.
   - Uphill along the scan where it slopes; toward the tooth axis on a flat ledge, where a move along the axis
     barely shifted a finish line.
   - The tool is busy while it runs, so a quick second key press does not start from the same line.
4. **Keyboard** (`ui/App.tsx`, the help sheet):
   - Enter on a closed margin goes to the next step;
   - N and Shift+N jump between doubtful parts;
   - [ and ] lower and raise the line;
   - Delete removes the hovered point;
   - Esc cancels.
5. **Cross-section:**
   - `geometry/crossSection.ts` keeps a per-scan 2 mm triangle grid, and cuts it with the plane spanned by the tooth
     axis and the outward direction through the cursor (worker `crossSection`, latest wins).
   - `ui/steps/MarginSection.tsx` draws the profile, the cursor, where the margin crosses that plane, and a 1 mm
     grid.
   - On by default, with a checkbox.
6. **Scribbles:**
   - `NaturalMarginInput.marks`: the patch vertices within 0.4 mm of each mark are fixed at tooth (1) or gum (0).
   - Mark tooth and Mark gum are brush modes: a drag paints, a click leaves one mark, and the release solves again.
   - Marks add up per tooth, with Clear marks, and are drawn blue and pink. For gum lines.
7. **Demo jaw:**
   - `DEMO_GINGIVA` (`geometry/synthetic.ts`): 0.4 mm of gum over the tooth bases and 1.4 mm papillae, but 0.4 mm
     papillae beside a prep (`gingiva.prepPapillaMm`), since the 36 prep's finish line sits about 1.47 mm above the
     gum.
   - Scanner-like colour.

**Measured** (`tools/pipeline-runner/src/natural/doubtCheck.ts`). A point is wrong when it is over 0.3 mm from the
true line:

| Lines | Wrong points flagged (recall) | Flags that are right (precision) | Share of line flagged |
|---|---|---|---|
| Real gum lines (23 development teeth), as found | 34% of the few wrong points | 76% | 1% |
| Same, a fifth pushed 1 mm up | 87% | 92% | 20% |
| Synthetic preps' finish lines, as found | 64% | 31% | 7% |
| Same, a fifth pushed 1 mm up | 36% | 69% | 12% |

About 20 ms per line. Finish lines needed a stricter rule (0.35 mm, 1.6× stronger) because of the convex line angles
near them, and they still flag less reliably: the colouring orders a review, it does not replace one.

**Deviations from the spec.**
- **A sign error caught by the measurement:** the first doubt run flagged 99% of correct lines. In a valley the
  second difference points along the normal, so a gum line's crease strength is +; it was −.
- **One rule became two:** gum lines keep the research's rule (0.25 mm, 1.3×). Finish lines use 0.35 mm and 1.6×,
  measured on the synthetic preps.
- **The offset** moves along the scan (`offsetOnSurface`) instead of along the axis and back. On the demo's 36, the
  axis-and-back version moved the line 0.013 mm for a 0.1 mm raise.
- **Tests placement:** the three tests are in `geometry/naturalMargin.test.ts`, not in new files, so they share its
  synthetic jaw (the speed rule).
- **Names:** the scribble input is `marks`, not `seeds` (seeds are the method's own). The offset worker call is
  `offsetPoints`; points and anchors go in two calls.
- **On a finish line with dense points** (the refiner's 48), almost every spot on the line is within reach of a point,
  so a click there grabs the point instead of adding one. Insert is for sparser lines (gum lines have about 9–16
  points).

**Verification.**
- `pnpm typecheck` clean. `pnpm test`: 123 tests (111 pass, 12 skipped), up 3 from 120:
  - **Doubt:** the found gum line has under 5% off, and a section pushed 1 mm up is over 60% off, and is the first
    stop.
  - **Edits:** an added point leaves the line unchanged; a dragged one changes only the stretch between its
    neighbours; a 0.3 mm raise lifts the line more than 0.15 mm.
  - **Marks:** tooth marks 0.8 mm outside one stretch move it more than 0.4 mm, and the far side less than 0.1 mm.
- `pnpm --filter @dcad/web build` passes.
- **Browser** (scripted Chrome on the new demo jaw):
  - one-click on 36 passes (finish line 27.7 mm);
  - one-click on natural 11 now completes, with its gum line passing every check;
  - in 11's Margin step: no doubtful parts; the section panel draws (148 segments, the margin marked); insert (9 → 10
    points, line unchanged), drag ("Point moved"), Delete (10 → 9), Mark gum (line found again), Enter (→ Insertion
    axis) all work.
- **Browser, offset:** on 36, three raises lift the line's mean height 0.13 mm (0.3 mm along the sloping shoulder),
  and one lower takes it 0.045 mm down. N on a line with no doubtful parts says so.
- **Browser scripts** on the new demo jaw: `first-run`, `ai-bridge`, `bridge` and `crown-move` all pass. The
  `crown-move` legend flake did not show this time.

**Follow-ups.**
- **The occlusal view key on an upper jaw** shows it from its back (the gum side): seen while scripting, and older
  than this change.
- **Doubt on finish lines** is weaker (36% of a pushed fifth); a better convex-edge test, or the refiner's own
  candidates, could do better.
- **Learned confidence** once technician-corrected lines exist.

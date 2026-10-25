# FDI handedness was mirrored

Status: **done** (2026-10-25).

## Report

The bridge-mode geometry agent found it while building the arch curve
([2026-10-25-bridge-mode.md](2026-10-25-bridge-mode.md)): `mesialFromBuccal` in
`apps/web/src/geometry/toothFrame.ts` gives the anatomically mirrored mesial direction. The synthetic arch
(`apps/web/src/geometry/synthetic.ts`) is mirrored the same way, so every test passed.

## Analysis

Take a right-handed scan frame with x = the patient's right, y = anterior, z = superior (RAS, the anatomical
right-handed convention). Scanners export proper (unmirrored) coordinates, and any rotation of them keeps the
handedness. For each quadrant, with posterior teeth (mesial ≈ anterior) and occlusal toward the antagonist:

| Quadrant | Side (x) | Occlusal | Buccal | Mesial | buccal × occlusal |
|---|---|---|---|---|---|
| 1 (upper right) | +x | −z | +x | +y | +y = mesial |
| 2 (upper left) | −x | −z | −x | +y | −y = distal |
| 3 (lower left) | −x | +z | −x | +y | +y = mesial |
| 4 (lower right) | +x | +z | +x | +y | −y = distal |

So the anatomical rule is:
- quadrants 1 and 3: **mesial = buccal × occlusal**
- quadrants 2 and 4: mesial = occlusal × buccal

The code had it the other way round. The synthetic arch put the patient's left at **+x**: `side = d < 0 ? 'right' :
'left'` with anterior +y and up +z. That is the mirror image of a real mouth, which is why the two errors cancelled
in every test.

**What it would do on a real scan:** the frame's mesial points distally for every tooth.
- `move_crown mesial` moves the crown distally.
- The mesial and distal contacts are swapped.
- The library template is mirrored.
- In bridge mode, the tooth-numbering side (`facingSide`) and the geometric side disagree. Contacts toward
  connected units would then be dropped on the wrong side.

## Goal and scope

Make the frames anatomically correct for real (unmirrored) scans, and make the synthetic data anatomically correct
too, so tests keep guarding the rule.

In:
- `mesialFromBuccal`: the rule above.
- `syntheticArch`: the patient's left at −x (`side = d < 0 ? 'left' : 'right'`). No geometry is mirrored and the
  winding is unchanged; only the side assignment of the teeth changes. The 36 prep moves to −x.
- Comments that state the old rule: `crown.ts` (`epsilon` is −1 in quadrants **2 and 4**), `arch.ts` (s grows
  mesially in quadrants 1 and 3), and the handedness fixtures and labels in `reducer.test.ts` and `crown.test.ts`.
- Test expectations that encoded the mirror:
  - `toothFrame.test.ts`: lower left buccal = −x.
  - `crown.test.ts`: 36 is right-handed, so its template is not mirrored.

Out: saved documents keep their stored frames, which are vectors. Designs made on real scans before this fix keep
their old (mirrored) frames until the frame step is re-run. There are no real-scan designs yet; golden data is
still pending.

## Verification plan

- `pnpm typecheck` and `pnpm test` pass, with the same test count. Per `CLAUDE.md`, a bug fix extends the closest
  existing tests (handedness in `toothFrame.test.ts`, 36 vs mirrored 46 in `crown.test.ts`) instead of adding new
  ones.
- On the synthetic arch, after the fix:
  - 36 is at x < 0, with mesial toward +y (anterior) and buccal toward −x.
  - 46 is mirrored.
  - The frames of 11 and 21 both point mesial toward the midline.
- The synthetic-36 pipeline-runner case still passes every check. Its output is the mirror image of before, so the
  regression hashes change once.
- Regenerate the demo fixtures (`data/synthetic`, gitignored) with `pnpm --filter @dcad/web fixtures`.

## Implementation summary

Landed together with bridge-mode wave 1, as one commit on main.

### What changed
- **The rule:** `apps/web/src/geometry/toothFrame.ts` `mesialFromBuccal` now gives quadrants 1/3: buccal × occlusal,
  and 2/4: occlusal × buccal. The derivation is in its doc comment.
- **The synthetic arch:** `apps/web/src/geometry/synthetic.ts` puts the patient's left at −x.
  - Teeth are assigned with `side = d < 0 ? 'left' : 'right'`, and the prep-point lookup is flipped to match.
  - The geometry and the winding are unchanged; only which teeth sit on which side changed.
- **Comments:**
  - `crown.ts`: `epsilon` is −1 in quadrants 2 and 4.
  - `arch.ts`: s grows mesially in quadrants 1 and 3.
  - `engine/gizmo.ts`: the X handle points mesial in quadrants 1 and 3.
- **Tests** (expectations only, no new tests):
  - `toothFrame.test.ts`: the four quadrant vectors in a right-handed patient frame.
  - `crown.test.ts`: 36 is right-handed, so its template is not mirrored, and 46 is mirrored.
  - `reducer.test.ts`: fixture names and labels.

### Verification
- `pnpm typecheck` and `pnpm test` pass (100 tests, including this wave's and the parallel UI session's).
- Synthetic-36 runner, scripted and `--auto`: both pass every check.
  - Frame origin x = −22.2 (the patient's left).
  - Mesial (0.39, 0.92, 0): anterior and toward the midline.
  - Buccal (−0.92, 0.39, 0): outward.
  - Template scale x positive (not mirrored).
- The regression hashes for the synthetic-36 output changed once, as planned: the case is now the mirror image of
  the old one.

### Follow-ups
- Confirm on one de-identified real lower scan that the 36 frame's mesial arrow points toward the incisors.
- Regenerate the local demo fixtures (`pnpm --filter @dcad/web fixtures`). They are gitignored, and the old files
  are mirrored.

# Dark theme: focus-view surroundings that read as tooth and gum

Status: **done** (2026-10-26).

## Goal

This follows up [2026-10-26-one-look.md](2026-10-26-one-look.md): "Dark theme: the see-through surroundings read dark
grey on the dark ground."

In the Crown proposal and Adapt steps, the focus view draws the rest of the prep's jaw and the antagonist at 40% opacity,
greyed by 0.35. On the light ground (#e9ecf0) they read as pale tooth and gum. On the dark ground (#20242a) the ground's
60% share wins: teeth turn dark grey and the gums maroon. The dark surroundings should read like the light ones (lighter,
neutral, clearly tooth and gum), with the crown and the prep still the strongest things on screen. The light theme must
stay pixel-identical.

The user asked for the smallest change that does this.

## Scope

**In:** the focus view's surroundings and antagonist on a dark ground; one line in DESIGN.md's 3D View section.

**Out:**
- Scans dimmed from the object panel, and a see-through crown. Neither is part of the focus view.
- A different opacity in dark. It would change how much of the crown shows through the neighbours.
- New browser checks or unit tests (the user asked to keep this small).

## Design

**A veil, derived from the ground** (`apps/web/src/engine/Viewer.ts`, `engine/materials.ts`). The surroundings are
blended as if over a ground no darker than a floor luminance, instead of the real ground:

- `out = α·c + (1 − α)·ground + veil`, with `veil = (1 − α) × max(0, floor − luminance(ground))`.
- On the light ground the veil is 0, so the light theme keeps its exact blend.
- On the dark ground the surroundings get the light theme's shading and tint amplitude (α·c), shifted by a constant. How
  much of the crown or the prep's jaw shows through them is unchanged (1 − α).
- The veil is added after three.js premultiplies the colour by alpha (`premultipliedAlpha` on the material, blending ONE,
  ONE_MINUS_SRC_ALPHA). Normal blending would need `c + veil/α`, which clips on bright teeth.
- `setBackground` already gets the theme's ground from `Viewport.tsx`, so the UI needs no change and `engine/` gains no UI
  import. `applyLook` sets the veil on focus surroundings only.

Prototype values were measured (below) on the demo case. A veil of 0.12 at 40% opacity reads light and keeps the gum's
tint, and the surroundings stay below the crown's contrast. That gives a floor of luminance 0.34 (sRGB 87).

## Verification plan

- `pnpm typecheck`, `pnpm test` (111: 99 pass, 12 skipped; no change), `pnpm --filter @dcad/web build`.
- **Browser scripts:** `crown-move` (light focus-view pixel classes, unchanged) and `first-run` (toggles dark).
- **Contrast:** a scratch script (not committed) captures the proposal step at a fixed oblique view in both themes. It
  classifies pixels by raycast as in `crown-move.mjs` and reports the mean |luminance − ground| of the surroundings and
  antagonist, before and after.
- **Light identity:** in one page session, render light with the change, strip the veil from the shader, render again
  and compare every pixel. Runs of the same code differ in about 100 pixels from run to run, so a comparison across runs
  cannot prove identity.

## Implementation summary

On the dark ground, the focus view's surroundings now read as pale tooth and gum. The light theme is unchanged.

**What was built, and where**
- `apps/web/src/engine/materials.ts`: a `uVeil` uniform, added to the colour after three.js premultiplies it by alpha.
  The uniform and the addition sit inside `#ifdef PREMULTIPLIED_ALPHA`, so a material without premultiplied alpha
  (every material in the light theme) compiles to the same program as before.
- `apps/web/src/engine/Viewer.ts`:
  - `setBackground` works out how far the ground's sRGB luma is below `SURROUNDINGS_GROUND_FLOOR` (0.34). The dark
    ground #20242a is 0.20 below it; the light ground is above it, so the lift is 0.
  - `applyLook` gives a see-through focus surface a veil of (1 − opacity) × that lift (0.12 at 40%), with
    `premultipliedAlpha` on. Without a veil, the material is as before.
- `DESIGN.md`: the 3D View section's See-through bullet gained one sentence for the dark theme.
- No UI change: `Viewport.tsx` already passes the theme's ground to `setBackground`.

**Measured** (demo case, Crown proposal, fixed oblique view, 1400 × 900; 6,400 raycast samples; luminance on sRGB 0–255;
contrast is the mean |luminance − ground|, as in `crown-move.mjs`, over the surroundings and antagonist pixels)

| | Light, before | Light, after | Dark, before | Dark, after |
|---|---|---|---|---|
| Surroundings and antagonist: mean luminance | 189.6 | 189.6 | 78.2 | 110.9 |
| Surroundings and antagonist: contrast with the ground | 45.8 | 45.8 | 42.6 | 75.2 |
| Neighbour teeth (RGB) | 200, 200, 200 | same | 79, 80, 81 | 110, 111, 112 |
| Gum (RGB) | 202, 186, 189 | same | 80, 65, 70 | 111, 96, 100 |
| Crown: contrast with the ground | 112.6 | 112.6 | 87.0 | 87.0 |

- **Before:** the dark contrast was about the light one. The surroundings were darker than mid-grey, though, so teeth
  read as shadow and gums as maroon.
- **After:**
  - teeth are a light neutral grey;
  - the gum keeps the light theme's tint (R − G 15, against 16 in light);
  - the crown stays above the surroundings in contrast (87 against 75) and is the only saturated surface;
  - the prep is at full strength, as before.
- **Light identity:**
  - in one session, the light render with the change and the same frame with the veil code stripped from every
    surface shader differ in 0 of 3,642,160 bytes;
  - switching to dark and back gives the same hash;
  - the sampled light statistics match the run before the change to the decimal.

**Prototypes measured and dropped**
- **Mixing the surroundings toward white, at the same opacity.** Teeth got lighter (luminance 104 at 0.45), but the
  shading flattened and the gum turned grey (R − G 4).
- **A higher opacity in dark.** It would change how much of the crown shows through the neighbours.

**Deviations from the spec**
- None in the design.
- Verification used only `crown-move` and `first-run`, per the user's scope trim; `offline-design` was not run, and
  `first-run.mjs` was not extended.

**Verification**
- `pnpm typecheck` clean.
- `pnpm test`: 111 tests (99 pass, 12 skipped without infrastructure), unchanged.
- `pnpm --filter @dcad/web build` passes.
- **Browser scripts:** `crown-move` passes all 30 checks; its light pixel classes still pass. `first-run` passes all 24
  checks, including the dark toggle.

**Follow-ups**
- Scans dimmed from the object panel get no veil on the dark ground. That is the same one-line condition in `applyLook`
  (drop `focus &&`), if it is wanted.

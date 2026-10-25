# Landing page and user journey

Status: **done** (2026-10-25).

## Goal

Someone from an outside lab or clinic who opens the site should understand what the product is, create a lab account
from the first screen, and reach a crown proposal on their first visit without help. Today the site opens on a bare
sign-in card titled "Dental CAD" that explains nothing. The editor has no Back or Next, and a step whose prerequisite is
missing is a dead end ("Set the tooth frame first.").

Decisions (user, 2026-10-25):

| Question | Answer |
|---|---|
| Where the landing page lives | At the site root, as a light static page. The editor moves to `/app/`. |
| Primary action | **Create a lab account.** Opening the demo case is the secondary action. |
| Product name | A neutral placeholder wordmark, `[Product name]`, until a name is chosen (PRODUCT.md: the name is open). |

## Scope

**In**
- **Landing page** at `/` (`apps/web/index.html` plus `apps/web/src/landing/`), with no React and no three.js. It is a
  Persuade surface: what the product is, the familiar step-by-step workflow, the five QA gates, "AI proposes, you
  decide", honest limits, and a working sign-up form in the first viewport.
- **Editor at `/app/`** (`apps/web/app/index.html`). Vite multi-page build, Caddy route, e2e default URL.
- **Journey fixes in the app** (Operate surface, incumbent look):
  1. Entry links: `/app/?demo` opens the demo case, and `/app/?signup` opens the sign-up form.
  2. The demo case: offline, synthetic scans loaded, tooth 36. It lands on Tooth frame with one-click crown armed, so
     the first click on the prep proposes a whole crown for review.
  3. The sign-in screen links back to the landing page and offers the demo case.
  4. First-run case list: when the lab has no cases, it explains what a case needs and offers the demo.
  5. Wizard footer: Back and "Next: <step>" on every step. Next is the primary button once the step is done. When a
     required earlier step is missing, a "Go to <step>" link replaces the dead-end warning.
  6. An opened case resumes at its first unfinished step instead of always opening on Scans.
  7. Scan import defaults to the active tooth's jaw (the prep scan) instead of always "Lower jaw".
  8. Coming back from offline mode re-checks the session, so a signed-in user who opened the demo isn't asked to sign
     in again.

**Out**
- Choosing the product name, and renaming the app's "Dental CAD" brand. Both swap together once a name exists.
- A lab or clinic name at sign-up. The API names the organization "<name>'s lab". Renaming it needs an organization
  update call. That's a follow-up.
- Pricing, customers, testimonials, benchmarks and certifications. None exist (PRODUCT.md), so the page claims none.
- Bridge-specific steps. The bridge-mode session (`specs/2026-10-25-bridge-mode.md`) adds `stepsFor(role)`. The step
  guide is written so pontics can drop the margin and axis steps in one place.

## Design

### Routing

- `apps/web/vite.config.ts`: the build has two inputs, `index.html` (landing) and `app/index.html` (editor). `base` and
  `BASE_URL` are unchanged, so `apiUrl()` and `assetUrl()` still resolve from the mount root, and the editor works
  under a sub-path (`/dental/app/`).
- `infra/Caddyfile`: `/app` redirects to `/app/`. `/app/*` falls back to `/app/index.html`, and everything else falls
  back to the landing page. The API route is unchanged.
- The landing page uses relative links (`app/`, `api/auth/...`), so it works at the root and under a sub-path.

### Landing page

- The visual direction is chosen in an impeccable direction round (see **Direction** below). The landing has its own
  stylesheet. The app's look is untouched.
- **Sign-up is a working form**: name, work email, password (10+ characters). It posts JSON to Better Auth's
  `api/auth/sign-up/email` (same origin, so the session cookie is set), then goes to `app/`. The API creates the
  personal organization. Errors are shown inline: an existing email, a short password, or an unreachable server (which
  points to the demo instead).
- If the visitor already has a session (`api/auth/get-session`), the form is replaced by "Open your cases".
- Demonstration numbers come from the real synthetic case and are labelled synthetic. They are the gate values of the
  same auto-design run that produced the images (see **Direction**), not hand-picked.
- Honest limits are stated on the page: single posterior crowns today, bridges next, not a medical device, synthetic
  or de-identified data only.

### App journey

- `apps/web/src/ui/stepGuide.ts` (pure):
  - `REQUIRED`: the steps a crown needs (scans, frame, margin, axis, proposal). Setup and parameters have defaults.
    Adapt is recommended. Finalize is the end.
  - `missingBefore(step, statuses)`: the first required step before `step` that is still pending.
  - `resumeStep(statuses)`: the first step from scans to adapt that isn't done (pending or stale), otherwise finalize.
- `apps/web/src/ui/StepFooter.tsx`: Back / Next, plus the "Go to" link for a missing prerequisite. It is rendered by
  `StepPanel` in `App.tsx`. The step panels are not edited, because the bridge session owns them.
- `apps/web/src/state/session.ts`:
  - `startDemo()`: the offline workspace, then demo scans, then Tooth frame with `autoArmed`.
  - `openCase()`: sets `activeStep` to `resumeStep()`.
  - `backToCases()`: when there is no user, it re-runs `init()` instead of going straight to the sign-in screen.
  - `readEntry()`: reads `?demo` or `?signup` once, then removes it from the URL.
- `SessionGate`: `?demo` skips the auth check and opens the demo. `?signup` opens AuthForm in sign-up mode.
- `CaseList`: shows the first-run panel when the list is empty.
- `ScanImport`: the default role is `jawOf(activeFdi)`.

## Verification

- `pnpm typecheck` and `pnpm test` pass.
- **One new test** (`apps/web/src/ui/stepGuide.test.ts`): resume and missing-prerequisite skip done steps and stop at
  pending and stale ones. It guards the journey routing that bridge mode will change. Test count 96 → 97.
- e2e (`tools/e2e/online-case.mjs`) starts from the landing page: sign up with the landing form, land on the case list,
  create a case, and the editor opens on Scans. `offline-design.mjs` runs against `/app/` unchanged.
- `vite build` emits both `index.html` and `app/index.html`. The landing page loads no three.js chunk.
- Screenshots of the landing page at 1440 and 390 wide, and of the first-run case list, the demo landing on Tooth frame
  and the wizard footer.
- `impeccable detect` on the changed files.

## Direction

The impeccable direction round (seed `seed:7ee96aaa080dc2bd`) assigned "Shade Guide": nine porcelain shade tabs, one
per wizard step. My own pick was "Die and Red Pencil". "Millimetre Grid Specimen" was a competitive challenger, and the
category standard was the standing exit. The decision page closed unanswered, so the same options were asked again
in the terminal. **The user chose the category standard**, played straight, with **exocad, Dentbird and Linear /
Vercel** as the craft bar. The choice is recorded as a brand commitment in `PRODUCT.md`. The direction contract is in
`apps/web/.impeccable/surfaces/index-html.md`. The four first-viewport sketches were deleted after the round, at the
user's request; the choice and its alternatives are recorded here.

- White ground, deep navy ink `#0f1b2d`, and the app's blue `#2f6fde` as the one accent. Hanken Grotesk, variable and
  self-hosted. Geist was the first choice, but the detector lists it as overused.
- **Real renders only.** `tools/e2e/landing-shots.mjs` drives the demo journey in the real app (open the demo, click
  the prep once, accept the draft) and captures the hero crown, the occlusion and thickness maps, the editor at
  Finalize, and the auto-design panel. Every number on the page comes from that run's gate values
  (`out/landing/metrics.json`): margin closed at 28.2 mm, 0 margin points in undercut, minimum thickness 1.01 mm
  against 0.50, occlusal clearance 0.05 mm, 0 self-intersections.
- The signature moment: on load, the checks panel runs its five gates top to bottom, the way auto-design does. It is
  skipped under reduced motion.

## Implementation summary

**Landing page** (`apps/web/index.html`, `apps/web/src/landing/`)
- Static HTML with real content, no React, no editor code. In the production build the landing page ships 3.6 kB of JS
  (`landing.ts`), 13 kB of CSS, one 35 kB variable font (Hanken Grotesk, self-hosted) and about 260 kB of WebP renders.
  The editor's 1.2 MB bundle loads only at `/app/`.
- **First viewport:**
  - the headline and a working sign-up form;
  - the hero render: the auto-design draft with the occlusal clearance map, and the editor's real "Draft ready" review
    in its lower-left corner;
  - the checks panel with five values from the same run.
  - On phones the order is headline, lede, render plus checks, then the form, and the header keeps Sign in plus
    "Create account".
- **Sections:**
  - Workflow: the editor at Finalize, with the toolbar cropped off so its working name doesn't show; phones get the side
    panel at 1:1. Then the nine steps.
  - Checks: a table, plus the occlusion and thickness maps with page-text scales transcribed from
    `tools/crownLegend.ts`.
  - AI assist: the first two steps of the real draft review.
  - Today versus not yet, a closing call to action, and the footer.
- `landing.ts`:
  - The sign-up form posts to `api/auth/sign-up/email`, then goes to `app/`. It validates name, email and a 10+
    character password before sending. It names an existing email ("Sign in instead") and an unreachable server
    (pointing to the demo).
  - `get-session` swaps the form for "Open your cases".
  - The checks panel settles each value once, from its gate threshold to the measured value, and a row passes only
    when its value lands. Skipped under reduced motion.
- **Images** (`tools/e2e/landing-shots.mjs`, re-runnable):
  - All are captured from the live editor on the synthetic case 36: demo entry, one click on the prep, the draft
    review, then Accept.
  - The hero and the banner come from the same open draft. `out/landing/metrics.json` records every number the page
    quotes, including each step's time.
  - `impeccable embed-prompt` records each image's origin in a `*.webp.json` sidecar.

**Routing**
- Vite builds two entries, `index.html` and `app/index.html`, via `build.rolldownOptions.input`.
- Caddy: `redir /app → /app/`, `@editor` (under `/app/`, not a file) rewrites to `/app/index.html`, and everything else
  falls back to `/index.html`.
- The e2e scripts default to `http://localhost:5173/app/`.

**Journey** (incumbent editor look)
- `ui/stepGuide.ts`: `REQUIRED`, `resumeStep`, `missingBefore` and `neighbours`. Each takes the unit's own step list,
  `stepsFor(unitKind(setup, fdi))` from bridge wave 1 (`54e88a7`), so a pontic is never sent to Margin or Axis.
- `ui/StepFooter.tsx`: a sticky Back / "Next: <step>" footer. Next is primary once the step is done. A missing
  required step gets a "Go to <step>" button.
- `state/session.ts`:
  - `enter()` reads `?demo` or `?signup` once and strips it from the URL. It is safe under StrictMode's double mount.
  - `startDemo()`: offline, demo scans, then Tooth frame with one-click crown armed, but only if the prep's jaw loaded
    and the user hasn't moved on.
  - `openCase()` resumes at the unit's `resumeStep()`.
  - Leaving the demo without a session re-checks the session and opens sign-up.
- The sign-in screen offers the demo case and links to the product page. The first-run case list explains what a case
  needs and offers the demo.
- `ScanImport` defaults to the prep's jaw, and its heading became an h3, "Import" (it duplicated the step title). The
  assistant panel starts closed offline.

**Deviations**
- The landing page's direction came from an impeccable direction round: the user took the category standard (see
  **Direction**).
- The demonstration numbers come from the capture run's gate values, not the headless pipeline run first planned. The
  images and numbers must come from one run. Bridge wave 1's FDI handedness fix moved them slightly (margin 28.2 →
  28.1 mm), and the page quotes the current run.
- Geist was swapped for Hanken Grotesk because impeccable's detector lists Geist as overused.
- Moving to Crown proposal after an auto-design draft: the polish session's `ae0e400` does this when the draft is
  ready, so my version was reverted from `AutoDesign.tsx`.
- An existing bug was fixed: `.session-card form` (flex column) outranked `.new-case` (grid), so the New case fields
  rendered as a right-aligned stack. The fix is `ui/session/journey.css`.
- After `54e88a7`, this checkout lacked `manifold-3d`, so the geometry worker never finished and the editor couldn't
  load scans. `pnpm install --frozen-lockfile` fixed it, and the bridge session now installs after landing lockfile
  changes.

**Review** (impeccable finish reviewer, run as a fresh subagent; impeccable's own reviewer agent isn't registered in
this harness)
- **Round 0, recapture:** lazy images were blank in the full-page captures. The captures now force eager loading and
  decode before shooting.
- **Round 1, fix:** eight material fixes:
  - the working name visible in the editor shot;
  - the count-in not starting from the thresholds;
  - the roadmap wording;
  - illegible map legends;
  - no product on the phone's first screen;
  - no AI proposal in the hero;
  - Sign in hidden on phones;
  - the workflow figure scaled to illegibility on phones.
  All eight were scored resolved.
- **Round 2, fix:** three regressions:
  - the banner claimed an occlusion map the hero didn't show;
  - a tall, repetitive AI panel;
  - an alt text that overclaimed.
- **Round 3, ship:** all three regressions resolved, with no new ones. The ship verdict covers the scored fixes, not a
  fresh full review of the page.

**Verification**
- `pnpm typecheck`: clean in every package, on the final tree including `ae0e400` and `54e88a7`. `pnpm test`: green,
  with web 76 passed and 1 skipped, API 10 passed and 11 skipped (no `TEST_INFRA`), shared 2, pipeline 1, for 101
  including skipped. This work adds **1 test** (`apps/web/src/ui/stepGuide.test.ts`, with pontic assertions). The
  parallel polish and bridge commits added the rest of the growth from 96.
- The demo journey, end to end (`tools/e2e/landing-shots.mjs`, headless Chrome, software WebGL):
  - `/app/?demo` lands on Tooth frame with one-click crown armed, both scans loaded and the query string removed.
  - One click on the prep passes all five auto-design steps. No page errors.
- Sign-up against the real API (Postgres in Docker, the API trusting the dev origin):
  - A short password is rejected on the client.
  - Landing sign-up lands on `/app/` with the first-run case list.
  - A new case opens on Scans.
  - The landing page then shows "You're signed in as …".
  - A duplicate email gives "An account with this email already exists. Sign in instead."
- `tools/e2e/online-case.mjs`, which now signs up on the landing page, passes against the real API: first-run case
  list, the new case opens on Scans, uploads, save v1, reopen equal, the crown recomputed identically, and the conflict
  on a stale save. The only console errors are the expected 404 (no version yet) and 409 (the deliberate conflict).
- `tools/e2e/offline-design.mjs` passes against `/app/`, through the STL and construction-info downloads (after the
  polish session's "Export STL anyway" confirm was added to the script).
- Caddy (`caddy:2` serving the production build through `infra/Caddyfile`), at `BASE_PATH=""` and at `/dental`:
  - `/` serves the landing page.
  - `/app` returns 308 to `/app/`, and `/app/`, `/app/?demo` and `/app/deep/link` serve the editor.
  - `/unknown` serves the landing page, and the assets return 200.
- `impeccable detect`: only the `cramped-padding` false positives remain, which the reviewer confirmed. After
  `DESIGN.md` existed, the detector also flagged four design-system mismatches in `landing.css` (the selection colour,
  two off-scale radii, monospace on `.dcad.zip`); all four are fixed.
- **`DESIGN.md` and `.impeccable/design.json`** were written at the repo root by the impeccable documenter. They cover
  the landing world (Hanken Grotesk, navy on white, Instrument Blue #2f6fde as the one accent, product shots with a
  hairline edge and one soft shadow, page-text map scales) and the editor's system, marked "maintained by the editor
  polish work". The North Star, "The Verifiable Instrument", and the colour names were chosen by the documenter and
  are not yet confirmed by the user.
  - Drift it logged without fixing: the uppercase `.session-card h2` and the accent side rail in `bridge.css` (other
    sessions' files).
  - Drift fixed here: hard-coded sizes in `StepFooter.css` and `journey.css`, now on the editor tokens.
- Screenshots at 1440, 1280 and 390 wide are in `apps/web/.impeccable/review/`.

**Follow-ups**
- **Name:** choose the product name, then replace `[Product name]` in `apps/web/index.html` (wordmark, title and
  footer) and the editor's "Dental CAD" (`Toolbar.tsx`, `AuthForm.tsx`, `app/index.html`).
- **Lab name at sign-up:** ask for the lab or clinic name and rename the personal organization through Better Auth's
  organization update.
- **Re-capture:** re-run `tools/e2e/landing-shots.mjs` and re-convert the WebPs whenever the editor's look or the
  synthetic case changes, so the landing images stay true.
- **Margin image:** add a capture of the Margin step (the live-wire line on the prep), which the reviewer named as the
  category's signature image.
- **Commit set:** decide what to commit from `apps/web/.impeccable/`. The surface brief, yes; `mocks/`, `review/` and
  `questions/` are scratch.

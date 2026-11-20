# Outreach readiness: trust pages, one data rule, a feedback path and a short video

Status: **done, partly** (2026-11-20): the outreach fixes and most of a lab owner's review of the editor are done; the crown-height check and the two default settings need a decision.

## Goal

A review of the site before cold outreach to lab owners found five things to fix first. A lab owner who gets a cold
message will not create an account, but will watch a short video, and distrusts an anonymous tool. So:

1. A 60–90 s video from scan to finished crown to STL export.
2. Contact details, an "about" section and a privacy page. The site had none.
3. One plain data rule. The site said "never real patient data" and also "cases stored for your lab".
4. The sign-up button's label. The page text read "Create lab accountCreate account".
5. A feedback button inside the app. The user chose email over a booking link (Calendly/WhatsApp): people write to
   `rohanakar@gmail.com`.

## Scope

**In:**
- The landing page (`apps/web/index.html`, `src/landing/`): About section, contact line, footer links, the video, the
  data rule, one button label.
- A privacy page at `/privacy/`, built by Vite like the landing page, served by a Caddy redirect like `/algorithm`.
- The feedback page and API above, and a Feedback link in the editor toolbar (`apps/web/src/ui/Toolbar.tsx`).
- The new-case form: the same data rule, where scans are chosen.
- A 60–90 s overview episode in the video series (`tools/e2e/video/episodes/`), copied to `apps/web/public/video/`
  for the landing page.

**Out:**
- A booking link. Contact is by email only (decision of 2026-11-20).
- The builder's name: `VITE_CONTACT_NAME` adds a "Built by" line; unset, the line is left out. The email defaults to
  `rohanakar@gmail.com` and `VITE_CONTACT_EMAIL` overrides it.
- An admin screen for reading feedback (SQL is enough for a beta).
- Legal review of the privacy text. It states what the code does; a lawyer should read it before a paid launch.

## Design

**Settings (`apps/web/src/site.ts`).** Reads the two `VITE_*` values. `applyContact(root)` fills
`[data-contact-email]` (href and text) and `[data-contact-name]`, and hides `[data-needs-email]` /
`[data-needs-name]` blocks whose value is unset. It runs from the landing and privacy
scripts, so the HTML files stay static and the address is not in the HTML source. Passed through the Docker build as
build args (`infra/proxy.Dockerfile`, `infra/docker-compose.yml`).

**The data rule.** One sentence, used on the landing page, the privacy page, the new-case form and the footer:
*"Beta: cases are stored on our server for your lab, so upload anonymised scans only. Rename the files: an STL holds
no patient details itself."* The "Not yet" list keeps "Not a medical device".

**Sign-up button.** The nav button had a long and a short label, switched by CSS. Text extraction and some readers
see both. It becomes one label, "Create account".

**About.** A short section: what the tool is, who builds it (name from settings), that it is a beta and what it is
for, and how to reach us. Plain text, no logos.

**Privacy page.** What is collected (name, email, password hash, cases and scans, design versions), where it lives
(our server; Postgres and file storage), who sees it (members of the lab; the assistant's text goes to the model
provider), what is not done (no ads, no selling, no analytics), how to delete (email), and the data rule.

**Feedback.** Email is the front line; a short form saved to the database is the fallback.
- Page `/feedback/` (a Vite entry like the landing page, `apps/web/feedback/index.html`): the email link first, then
  "Or send it here" with a message (required, 2000 characters), an optional reply address, and Send. It works without
  an account. The editor's toolbar has a Feedback link that opens it in a new tab (`?from=editor`); the landing
  page's About section and footer link to it.
- API: `POST /api/feedback` (`packages/shared/src/api.ts` `FeedbackRequest`), open to visitors without a session
  and mounted before the session check. A session, when present, records user and org. Rate limit: 5 per hour per
  client address (`apps/api/src/domain/feedback.ts`). Table `feedback` (migration `0001`); not org-scoped, since the
  sender may have no account. Read it with SQL; there is no admin UI.

**Video.** One episode, `00-overview`, 60–90 s: demo → auto-design → accept → Export STL → what next, with the
checks the quick start already makes. Filmed by the existing director. The MP4 and a poster go to
`apps/web/public/video/`, and the landing hero links to it as a "Watch the 65-second video" button that opens a
`<dialog>` player (no autoplay; no video bytes until it is opened, `preload="none"`).

## Verification

- `pnpm typecheck`, `pnpm test`, `vite build` pass.
- **Tests:** one unit test, `apps/api/test/feedback.test.ts`, runs without Docker: a message is stored with and
  without a session, an empty or oversized body is rejected by `FeedbackRequest`, and the sixth message in an hour from
  one address is rate-limited. The rest is static content and links (`CLAUDE.md`: no tests for labels or text).
- Browser check on `pnpm dev:web`: the nav shows one button label at desktop and phone width; the About, contact
  and footer render; `/privacy/` renders; the Feedback link opens the page from the editor and the demo, and Send stores a row; with the name
  unset nothing shows "undefined" or an empty link.
- The overview episode passes its checks, and `ffprobe` shows a duration of 60–90 s.

## Second batch: a lab owner's review of the editor

Raised during the same work (2026-11-20), from a trial of the demo. Scope and what was done:

| Finding | Decision |
|---|---|
| "All 14 checks passed" shows while 6 of 7 rows under it still say "Measuring…" | **Fixed.** The verdict reads "Draft ready: measuring the last checks…" and Accept waits, until no row is unmeasured. |
| Tooth frame turned "done" with "Frame set on 36" after clicking back to Case setup, with no click on the prep | **Reworded, not removed.** The app sets frames itself from the prep it finds, as soon as a scan loads (`tools/autoFrames.ts`, a deliberate feature). The step now says "Frame set automatically on 36 from the prep found in the scan". The rail still shows the step done. |
| A failed occlusion row gave "Off since the last change", not how far the crown went in | **Fixed.** While adaptation is stale the row measures the crown as it stands (clearance maps) and says "now -0.31 mm to the antagonist, the crown is in it". Contacts say the same against a neighbour. |
| Buccal and Lingual show the whole arch | **Fixed.** With the working tooth framed, Buccal, Lingual, Mesial and Distal look at that tooth (60 mm). Occlusal still frames the arch. |
| The occlusal view looks onto the upper jaw's gum | **Fixed.** Occlusal hides the opposing jaw. |
| No quick way to hide the opposing jaw | **Added.** A "Hide opposing" toggle in the toolbar. |
| Camera inside the upper jaw's gum on Scans and Tooth frame | **Not reproduced.** The demo's Tooth frame step shows the lower jaw only. Likely the same cause as the occlusal view; "Hide opposing" is the workaround. Needs the case that shows it. |
| The crown is too high; the occlusion check passes | **Measured, not fixed.** On the synthetic case the crown's top stands about 2.8 mm above the mesial neighbour's and 3.6 mm above the distal one's (cusp heights near the contacts, along the occlusal axis). The cause: the proposal sets the crown's height from the distance to the antagonist (`proposeCrownPose` in `geometry/crown.ts`), and the synthetic upper arch is not closed on the lower one (the gap between the front teeth). The checks measure only the gap to the antagonist. The fix has two parts: cap the proposed height at the neighbours' level plus an allowance, and add a "level with neighbours" row. Both would make the demo fail its occlusion check until the synthetic bite is closed, and move the golden cases, so they need a threshold chosen with a lab and a re-run of all 15. |
| Default proximal contact is a 0.02 mm gap, and Help calls below 0 "too tight"; labs often design contacts slightly tight | **Open question for labs.** Not changed. |
| One "zirconia" setting for zirconia types that need different minimum thicknesses | **Open question for labs.** Not changed; it needs the thickness per type from a lab or the material's maker. |

The Feedback link in the editor toolbar also lost its link underline (`.btn` now sets `text-decoration: none`).

## Implementation summary

**What was built.**
- **Site:** About section, contact line and footer links on the landing page; `/privacy/` and `/feedback/`
  (Vite entries in `apps/web/vite.config.ts`, Caddy redirects in `infra/Caddyfile`); one data rule
  (`src/site.ts` `DATA_RULE`) on the landing page, privacy page, new-case form and sign-up note; one sign-up button
  label ("Create account"; the long and short labels are gone). The contact address is `rohanakar@gmail.com`, with
  `VITE_CONTACT_EMAIL` and `VITE_CONTACT_NAME` build args (`infra/proxy.Dockerfile`, `infra/docker-compose.yml`).
- **Feedback:** email first, then a short form that saves to the database. `POST /api/feedback`
  (`apps/api/src/http/routes/feedback.ts`, `src/domain/feedback.ts`), table `feedback`
  (`apps/api/drizzle/0001_happy_stingray.sql`), shared schema `FeedbackRequest`. Open to visitors without an account,
  5 per hour per address. The editor's toolbar links to the page. No booking link, as decided.
- **Video:** `00-overview` in the walkthrough series (`tools/e2e/video/episodes/00-overview.mjs`; `promo: true` in
  `director.mjs` skips the title card, end card and "Next" line). 64 s, 6/6 checks, in
  `apps/web/public/video/overview.mp4` (1.8 MB, 1280 px) with a poster, opened from a button in the hero in a dialog
  that loads nothing until opened.
- **Editor:** the second-batch fixes in the table above.

**Deviations.**
- The data rule says cases are stored (they are) and asks for anonymised scans, rather than "never real patient data".
- The privacy text says the assistant sends typed text and measured numbers, not scans. I read the LLM port, not every
  call site: check that sentence before relying on it.
- The overview is 64 s, not the 75 s in the first draft; the title and button say 65.

**Verification.**
- `pnpm typecheck` clean; `pnpm test`: web 97 passed, 1 skipped; pipeline-runner 7; API unit tests plus the new
  feedback test (API integration tests skip without `TEST_INFRA=1`; **not run**, nor was the migration applied to a
  Postgres).
- Test count: +1 (`apps/api/test/feedback.test.ts`).
- Browser: landing at 1280 and 390 px (nav shows one "Create account"), the video dialog opens and sets its source,
  `/feedback/` and `/privacy/` render, no page errors, no "undefined" text. `first-run` passes after the verdict
  change (`first-run` and the episodes `00` and `01` now wait for the final verdict).
- **Not run:** the other 12 offline browser scripts, after the Buccal/Lingual and Occlusal changes (some may
  project clicks after a view change); sending a feedback row through the running API; the golden cases.

**Follow-ups.**
- Run the other browser scripts and fix any that the new views break.
- The crown-height check and cap, with the synthetic bite closed (see the table). Contact and zirconia defaults: ask labs.
- Reproduce the camera-in-the-gum case on the Scans step.
- Read the feedback table: `select created_at, email, page, message from feedback order by created_at desc;`.

# Browser end-to-end scripts

These scripts drive the real web app in headless Chrome (Playwright, `channel: 'chrome'`) through the dev-only
`window.__dcad` hook (`apps/web/src/debug.ts`). Screenshots go to `out/e2e/`.

- `offline-design.mjs`: continue offline → demo scans → tooth frame (click on the prep) → live-wire margin
  (8 clicks on the analytic synthetic margin, close) → margin deviation → anchor drag + undo → insertion axis → tilt +
  undercut map → undo → crown proposal → cement-gap edit (recompute) → export STL + construction info (saved to
  `out/e2e/`).
- `online-case.mjs`: needs the API on :3000 with Postgres. Sign up → new case → demo scans uploaded → frame, margin,
  axis → crown → Ctrl+S → reload → reopen the case (scans re-downloaded and sha-verified, document equal, crown
  recomputed identically) → stale save from a second tab gives a conflict.
- `crown-move.mjs` (offline): one-click crown left pending → keyboard nudge, gizmo drag and nudge pad before Accept
  (draft auto-accepted, instant preview, no snap-back, adaptation off until Re-adapt, open contact reported, undo and
  redo) → focus view (pixel classes with focus on and off) and the blue crown. Exits non-zero on a failed check.
- `bridge.mjs` (offline): posterior bridge 35–[36]–37 on `lower-bridge.stl` through every step (abutment frames, align
  to arch, place pontics and a ridge click, margins, common axis, Propose bridge, click-to-activate and a nudge,
  adaptation, a connector edit, Check bridge, Finalize, export; the STL is parsed in Node as one closed solid of
  genus 0), then the anterior bridge [12]–11–21–[22] up to Propose bridge. Screenshots go to `out/e2e/bridge/`
  (`E2E_OUT`); `E2E_ONLY=posterior|anterior` runs one part. Exits non-zero on a failed check.
- `ai-bridge.mjs` (offline): bridge auto-design on 35–[36]–37 after one click on each prep. An oversize connector stops
  the draft at the connector gate (Reject from the Adapt step); then every gate passes → Accept (one undo entry,
  events per unit and step) → the agent's bridge metrics → Finalize "Ready to mill"; then the one-click bridge (a
  click on each prep starts the run). Screenshots go to `out/e2e/ai-bridge/` (`E2E_OUT`). Exits non-zero on a failed
  check.
- `anterior-export.mjs` (offline): crowns on 11 and 21 of an upper arch whose front teeth lean 25° labially (generated
  in the page with `syntheticArch`'s `anteriorLeanDeg`) plus the bridge 35–[36]–37 on `lower-bridge.stl`. The setup
  hint for the separate crowns; every margin point of 11 reachable from the Margin step's view (against the old view
  along the occlusal-plane normal); a margin traced from the old view flagged in the Margin step (warning and kink
  marker) and in Crown proposal, "Fix the margin"; crowns and the bridge; Finalize → Export all, with the zip unzipped
  in Node (each STL a closed solid, the manifest). Screenshots go to `out/e2e/anterior/` (`E2E_OUT`). Exits non-zero
  on a failed check.
- `framework.mjs` (offline): a reduced CoCr single crown on 36 (demo scans) and a reduced CoCr bridge 35–[36]–37 on
  `lower-bridge.stl`. The Setup switch (Reduced, CoCr); frame, margin, axis and the proposal (a printable framework
  with its veneering space); the Adapt cutback panel with the Framework and Both views, the veneer-space map and a
  cutback edit (1.2 mm, overpress on; overpress on every bridge unit); Check bridge (one framework solid of genus 0,
  connectors at the CoCr area, three overpress parts); Finalize exports of the framework and overpress STLs, each
  parsed in Node as a closed solid, and the sidecar's framework section. Screenshots and downloads go to
  `out/e2e/framework/` (`E2E_OUT`); `E2E_ONLY=single|bridge` runs one part. Exits non-zero on a failed check.
- `maryland.mjs` (offline): the Maryland bridge 11w–[12] on the golden case `synthetic-maryland-11-12` (write it with
  `pnpm --filter @dcad/pipeline-runner run --synthetic`): setup (Wing on 11), the frame click on the palatal surface,
  the "Wing outline" live-wire, the common axis, Propose bridge, the Adapt wing panel and Check bridge, Finalize and
  the export (one closed solid of genus 0; the sidecar carries the wing). Screenshots go to `out/e2e/maryland/`.
- `inlay.mjs` (offline): the inlay bridge 35i–[36]–37i on the golden case `synthetic-inlay-bridge-35-37` (written by
  the same `--synthetic` run): setup (Inlay on 35 and 37), the jaw, antagonist and pre-op scans (the pre-op scan starts
  hidden), the frame clicks on the cavity floors, the "Cavity margin" live-wire, the common axis, Propose bridge (outer
  surfaces from the pre-op scan), the switch to the library tooth and back, the Adapt inlay panel and Check bridge,
  Finalize, the export (one closed solid of genus 0; the sidecar carries the inlays) and Export all. Screenshots go to
  `out/e2e/inlay/`.
- `ai-implant.mjs` (offline): implant auto-design on `lower-implants-35-37.stl` (`fixtures:implant`). The bridge
  35i–[36]–37i one-click (a click on each scan body): the scan-body match replaces the margin, and at the default
  0.8 mm channel wall the draft stops at "Screw channel 35"; Reject, 35's wall at 0.55 mm (the synthetic teeth are
  about 0.7× natural size), then every gate passes → Accept → the agent's channel metrics → Finalize "Ready to mill".
  Then a single implant crown on 37: frame → implant position → crown → screw channel → adapt. Screenshots go to
  `out/e2e/ai-implant/` (`E2E_OUT`; `E2E_ONLY=bridge|single`).
- `ai-maryland.mjs` (offline): Maryland auto-design on `synthetic-maryland-11-12`: one click on 11's palatal surface →
  the wing outline proposed (classical.wing-outline) → axis, bridge, adapt (the wing skipped), the connector and union
  gate with the wing checks → Accept → Finalize. Screenshots go to `out/e2e/ai-maryland/`.
- `ai-framework.mjs` (offline): framework auto-design: the CoCr bridge 35–[36]–37 (facial 1.2 mm cutback) and a
  single reduced zirconia crown 36 (full 1.0 mm). The cutback gate stops both drafts on the synthetic preps' veneer
  shortfall (their walls are thinner than the framework minimum, as the runner reports); the agent's veneer metrics.
  Screenshots go to `out/e2e/ai-framework/`.
- `first-run.mjs` (offline): a first-time visitor's journey. Sign-in screen → Try the demo case → Tooth frame looking
  down onto the lower jaw, the prep of 36 ringed and inside the viewport → a click on 35 refused (nothing runs) → a
  click in the ring → the draft reviewed in one verdict line, checks folded, Accept the only primary → Accept said in
  the status line inside the window → Finalize → export → the ending, with Parameters and Finalize done on the rail →
  `?` opens the help sheet → Start your own case → Case setup with the dentist's-view chart (24 px pitch, inside the
  wider panel). Screenshots go to `out/e2e/first-run/`.

Scripts that set an inlay, onlay, wing, implant or reduced unit open "More types" for that tooth first (`moreTypes`).

Clicks on the scan (`clickWorld` in `ai-bridge.mjs`, `bridge.mjs`, `implant.mjs` and `framework.mjs`) wait until the
surface under the projected point is the target, within 0.3 mm. In headless Chrome with SwiftShader a frame of a
1M-triangle scan can take longer than the 250 ms between two camera samples, so a click right after a view change
could land on whatever hid the point in the previous view. For the same reason `settle()` in `bridge.mjs`,
`implant.mjs` and `framework.mjs` also waits for three rendered frames in a row with the camera unchanged.
camera-controls' `active` is no idle signal: a move that ends in one step (a jump, or one long frame) goes to sleep
without a 'rest' event and leaves it true.

```bash
pnpm dev:web                          # terminal 1 (and pnpm dev:api + Postgres for the online script)
pnpm --filter @dcad/e2e offline       # or: online, move, bridge, ai-bridge, implant, anterior, framework, maryland,
                                      #     ai-implant, ai-maryland, ai-framework, first-run
```

Day 7 turns these into `@playwright/test` specs.

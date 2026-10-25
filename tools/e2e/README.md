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

```bash
pnpm dev:web                          # terminal 1 (and pnpm dev:api + Postgres for the online script)
pnpm --filter @dcad/e2e offline       # or: online, move, bridge
```

Day 7 turns these into `@playwright/test` specs.

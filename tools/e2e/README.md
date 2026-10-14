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

```bash
pnpm dev:web                          # terminal 1 (and pnpm dev:api + Postgres for the online script)
pnpm --filter @dcad/e2e offline       # or: online, move
```

Day 7 turns these into `@playwright/test` specs.

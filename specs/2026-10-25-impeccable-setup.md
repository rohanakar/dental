# Impeccable design skill setup

Status: **done** (2026-10-25).

## Goal

Install the [impeccable](https://github.com/pbakaus/impeccable) design skill (`npx skills add pbakaus/impeccable`) and
set it up for DentalCAD, so Claude can critique, audit, polish and extend the web UI with commands such as
`/impeccable critique`, `/impeccable audit` and `/impeccable polish`, using the project's real product context.

## Scope

**In**
- Project-level install for Claude Code: `.claude/skills/impeccable/` and `skills-lock.json` at the repo root.
- `PRODUCT.md`, impeccable's product record, written through its `init` flow: users, purpose, positioning,
  constraints. No visual decisions.
- `.impeccable/config.json` with the workflow defaults the user chose: build path and the design-detector hook.
- The hook wiring in `.claude/settings.local.json` (per developer, not committed).
- Live-mode config (`.impeccable/live/config.json`) pointing at the Vite shell `apps/web/index.html`, if the CSP
  check allows it.

**Out**
- `DESIGN.md`, a record of the current visual system. That is impeccable's separate `document` command, offered
  as the next step.
- Any change to the UI itself.
- Commit and push (only on request).

## Decisions (user, 2026-10-25)

| Question | Answer |
|---|---|
| Primary user | Lab CAD technicians **and** clinicians (chairside dentists who design their own crowns) |
| Stage | A product for outside labs: first-time users, trust, onboarding and consistency matter |
| Build path for landing/showcase pages | Code-first (app screens are always code-first) |
| Design-detector hook | On |

## Design

- impeccable's context loader (`.claude/skills/impeccable/scripts/impeccable context`) finds one UI app,
  `apps/web`. The other seven workspaces have no UI.
- `PRODUCT.md` lives at the repo root, because it describes the product, not one app. `apps/web` inherits it.
- The impeccable engine is a native binary. The launcher downloads it once to `~/.impeccable/bin/<version>/` and
  checks its sha256. It is not in the repo.

## Verification

- `impeccable context` run from `apps/web` resolves `productPath` to the root `PRODUCT.md`, with platform `web`.
- `impeccable hooks status` reports the hook enabled. `.claude/settings.local.json` has the hook entries.
- `impeccable detect --json apps/web/src` runs, giving a baseline count of findings (recorded below, not fixed).
- No code changes, so `pnpm typecheck` and `pnpm test` are unaffected. No tests are added.

## Implementation summary

**What was set up**
- **Skill:** `npx skills add pbakaus/impeccable -a claude-code -y` installed impeccable 4.7.1 (engine 0.1.17), 62
  files and 2.3 MB, as a copy in `.claude/skills/impeccable/`. `skills-lock.json` pins the source and content hash.
  The installer's risk check: Gen "Safe", Socket "1 alert", Snyk "Low Risk".
- **Engine:** the launcher downloaded the native binary into `~/.impeccable/bin/0.1.17/` (outside the repo) after
  checking its sha256.
- **Product record:** [PRODUCT.md](../PRODUCT.md) at the repo root covers users, purpose, positioning, operating
  context, capabilities, evidence on hand and four product principles. It holds only confirmed facts. Open items are
  marked as open, for example whether "DentalCAD" is the final name.
- **Shared config:** `.impeccable/config.json` records `buildPath: "code"` and the enabled hook.
- **Local, uncommitted files:**
  - `.impeccable/config.local.json`: the hook consent. impeccable added it and its hook cache to `.git/info/exclude`.
  - `.claude/settings.local.json`: the hook wiring (`PostToolUse` on Edit/Write, plus a `Stop` deep pass). The global
    gitignore already excludes it.

**Deviations**
- **Live mode is not configured yet.** `impeccable live` stops with `context_missing: DESIGN.md`, so live mode needs
  `/impeccable document` first. The CSP check found no CSP, so nothing else blocks it. On first use, live mode writes
  its own config (`files: ["index.html"]` for this Vite shell).
- **Bridge specs:** `PRODUCT.md` lists the five bridge, inlay and implant specs written the same day by another
  session, so the record matches the planned scope.

**Verification**
- `impeccable context` run from `apps/web` resolves `productPath` to `../../PRODUCT.md` with platform `web`. The
  remaining directive is `INCUMBENT_WORLD_UNDOCUMENTED`: the current UI is the design authority until DESIGN.md exists.
- `impeccable hooks status`: enabled, with the shared and local config files present.
- Baseline `impeccable detect --json src index.html` (from `apps/web`) found 1 warning: a side-tab accent border on
  `.hint-box` (`apps/web/src/styles.css:412`). It was recorded, not fixed.
- No code changed, so typecheck and tests were not run. No tests were added.

**Follow-ups**
- Run `/impeccable document` to write `DESIGN.md` from the current tokens in `apps/web/src/styles.css`. It needs a
  short interview about visual character, and it unlocks live mode.
- Decide whether to commit `.claude/skills/impeccable/`, `skills-lock.json`, `PRODUCT.md` and `.impeccable/config.json`
  so everyone working on the repo gets the skill.
- impeccable's anonymous telemetry is on by default. Turn it off with `impeccable telemetry off` or
  `DO_NOT_TRACK=1` if wanted.

# Specs index

One spec per task, in the order the work happened. See `CLAUDE.md` for the workflow. `plan.md` is the master plan
and progress log.

| Spec | Status |
|---|---|
| [plan.md](plan.md): 1-week MVP plan | living document |
| [day-01-foundations.md](day-01-foundations.md): monorepo, shared schemas, scan viewer, API, infra | done |
| [day-02-setup-frame-margin-axis.md](day-02-setup-frame-margin-axis.md): case setup, tooth frame, live-wire margin, insertion axis, pipeline runner, web↔API | done |
| [2026-10-11-simplify-deploy-npm.md](2026-10-11-simplify-deploy-npm.md): minimal compose wrapper, no deploy script, behind Nginx Proxy Manager on `shared_net` | done |
| [day-03-walking-skeleton.md](day-03-walking-skeleton.md): intaglio, template crown, stitch, validate, STL export | done |
| [day-04-fit-and-feedback.md](day-04-fit-and-feedback.md): RBF fit, thickness enforcement, colour maps, clinical moves, gizmo | done |
| [day-05-adapt-and-persist.md](day-05-adapt-and-persist.md): occlusion/contact adaptation, self-intersection, project zip, nightly backups | done |
| [2026-10-11-database-url-expansion.md](2026-10-11-database-url-expansion.md): `${POSTGRES_PASSWORD}` in DATABASE_URL (expanded + URL-encoded by the API) | done |
| [day-06-ai-layer.md](day-06-ai-layer.md): proposers + one-click orchestrator with QA gates, LLM agent tool loop, Rx intake, proposal events | done |
| [2026-10-14-crown-move-after-proposal.md](2026-10-14-crown-move-after-proposal.md): moving a proposed crown re-adapts it, preview/result mismatch, open contacts pass QA, moves inside an unaccepted draft; focus view and a distinct crown colour | done |
| [2026-10-14-test-cleanup.md](2026-10-14-test-cleanup.md): cut the suite to core-only tests (267 → 96 tests, 42 → 33 files) | done |
| [2026-10-25-bridge-mode.md](2026-10-25-bridge-mode.md): bridges as exocad allows them (any teeth incl. anterior, cantilevers, midline, full arch): retainers, ridge-contact pontics, connectors, common insertion axis, one-solid union and export | done for the core: manual and one-click bridges in the editor (follow-on types in their own specs) |
| [2026-10-25-fdi-handedness-fix.md](2026-10-25-fdi-handedness-fix.md): the FDI mesial rule and the synthetic arch were both mirrored; real scans would have had mesial and distal swapped | done |
| [2026-10-25-framework-bridges.md](2026-10-25-framework-bridges.md): reduced crowns and pontics (cutback for layering), overpress and pressed pontics, CoCr/titanium; after bridge mode | phases A+B landed (editor + runner + export); AI items next |
| [2026-10-25-maryland-bridges.md](2026-10-25-maryland-bridges.md): resin-bonded wing retainers (single-retainer cantilever and two-wing), surface-patch retainer geometry | phases A+B landed (editor + runner + export); AI items next |
| [2026-10-25-inlay-bridges.md](2026-10-25-inlay-bridges.md): inlay and onlay retainers and single restorations, outer surface from the pre-op scan or the library tooth (snap and subtract) | in progress (phase A geometry landed) |
| [2026-10-25-implant-bridges.md](2026-10-25-implant-bridges.md): screw-retained implant crowns and bridges on Ti-bases: scan-body registration, emergence profile, straight and angled screw channels | phases A+B landed (editor + runner); AI items next |
| [2026-10-25-impeccable-setup.md](2026-10-25-impeccable-setup.md): impeccable design skill installed for Claude Code, root `PRODUCT.md`, detector hook on, code-first build path | done |
| [2026-10-25-landing-and-journey.md](2026-10-25-landing-and-journey.md): landing page at `/` (category standard, real renders, working sign-up), editor moved to `/app/`, demo entry, first-run case list, wizard Back/Next, resume at the first unfinished step | done |
| [2026-10-25-ux-critique-polish.md](2026-10-25-ux-critique-polish.md): impeccable critique (24/40) and polish: contact-centred colour maps, ready-to-mill Finalize with a soft export gate, AI draft review, sharper instrument styling | done |
| [2026-10-26-anterior-margin-and-export-all.md](2026-10-26-anterior-margin-and-export-all.md): Margin view along the prep's own axis (proclined front teeth), kinked-margin warning before the proposal, Export all as one zip with a readiness manifest, separate-crowns hint in setup | done |
| [2026-10-26-anterior-tooth-frame.md](2026-10-26-anterior-tooth-frame.md): front-tooth frame from the prep's own axis (leaning incisors), synthetic leaning front teeth, E2E click guards, framework E2E | done |

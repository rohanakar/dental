# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Dental lab CAD technicians.** They design restorations for a living, many of them all day, and most know
  exocad's wizard. They want speed, precision and control, and they judge a design by its colour maps and
  measurements.
- **Clinicians.** Chairside dentists who design their own crowns. They use CAD occasionally and know the clinical
  terms but not every CAD convention, so the workflow has to guide them without slowing down the experts.

The job: turn an order (tooth, material, shade, prescription) and intraoral scans into a restoration that seats on the
prep, touches its neighbours and the opposing teeth correctly, is thick enough, and mills cleanly.

## Product Purpose

DentalCAD is a browser-based dental CAD. It brings exocad's most-used workflow, a single crown designed step by step,
to the browser, with nothing to install and cases stored in the cloud. It is built so AI can take over the routine
steps while the user keeps control.

Success: a technician or clinician goes from scans to a watertight, millable STL faster than in desktop CAD, and trusts
the result enough to send it to the mill.

Stage: becoming a product for outside labs and clinics, not only an in-house prototype. Design work should assume
first-time users from other labs, and the feature set will grow (bridges are next).

## Positioning

- **Familiar workflow:** exocad's step-by-step wizard (setup → scans → frame → margin → axis → params → proposal →
  adapt → finalize), in the browser.
- **AI proposes, the user decides:** AI assist goes through the same validated commands as the UI. Every AI change is
  a reviewable draft with Accept and Revert, and undo always works.
- **Deterministic geometry:** quality gates (closed margin, no undercut at the margin, minimum thickness, occlusal
  clearance, no self-intersection) check every proposal. LLMs orchestrate and explain. They never produce clinical
  geometry.

## Operating Context

- Desktop browser, mouse and keyboard. Users zoom into one tooth for long stretches and use keyboard shortcuts for
  views (1–5, F, O) and nudges. Touch and tablet use have not been designed for.
- Input: intraoral scans as STL or PLY (upper jaw, lower jaw, prep), already in occlusion, plus the order or a pasted
  prescription.
- Output: a binary STL plus a JSON construction sidecar (like exocad's `.constructionInfo`) for CAM and milling. A
  `.dcad.zip` project file for save and load. Design versions are stored on the server.
- Accounts belong to organizations (labs or clinics). Cases are scoped to one organization.
- Units are millimetres. Teeth use FDI numbering (e.g. 36). Directions use clinical terms: mesial, distal, buccal,
  lingual, occlusal, cervical.

## Capabilities and Constraints

- **Built:** case setup (FDI tooth chart, material presets, Rx intake), scan import, tooth frame and neighbour contacts,
  live-wire margin (plus automatic margin), insertion axis with undercut map, restoration parameters, library crown
  proposal with gizmo and nudges, adaptation to antagonist and neighbours, colour maps (occlusion, contacts,
  thickness, undercut, unmillable), validated export, undo and redo, one-click auto-design with QA gates, an LLM design
  assistant for plain-language edits.
- **Scope:** built for single crowns on premolars and molars. Specs awaiting review (2026-10-25) extend it to
  bridges on any teeth including anterior (`specs/2026-10-25-bridge-mode.md`), then reduced and framework bridges,
  Maryland bridges, inlay and onlay retainers, and screw-retained implant crowns and bridges. The scope is growing
  toward what exocad allows.
- **Out for now:** veneers, virtual articulator, automatic bite alignment, DICOM, photos.
- **Not a regulated medical device.** Only synthetic or de-identified data is allowed. No real patient data.
- **Terminology:** margin, insertion axis, undercut, blockout, intaglio, cement gap, spacer, antagonist, contact,
  minimum thickness, unmillable, retainer, pontic, connector. Use the clinical term the user already knows.
- **Open:** whether "DentalCAD" is the final product name. It overlaps with exocad's product name, "exocad
  DentalCAD".

## Evidence on Hand

- Synthetic scan fixtures (`tools/fixtures`) and a headless golden-case runner (`tools/pipeline-runner`).
- De-identified golden cases live in `data/`, which is gitignored and never shown publicly.
- Design docs for the product, architecture and AI assist: `documentation/*.html`.
- **None yet:** customers, testimonials, case studies, accuracy benchmarks against exocad, pricing, certifications.
  Never invent them.

## Product Principles

1. **The user decides.** AI and automation propose. Nothing changes the design without a visible draft and a way back.
2. **Measure, don't guess.** Show millimetres, colour maps and pass or fail checks. A design is judged on numbers the
   user can verify.
3. **Expert speed, newcomer clarity.** Keep the exocad conventions experts rely on, and guide clinicians and
   first-time users through the same flow, not a separate one.
4. **Honest about limits.** Report conflicts plainly ("insufficient reduction", unmillable areas, open contacts)
   instead of hiding or silently fixing them.

## Brand Commitments

- **Marketing surfaces play the category standard straight** (user, 2026-10-25): white ground, deep navy ink, the
  app's blue as the one accent, real product renders instead of illustration. The craft bar is exocad, Dentbird and
  Linear / Vercel. The landing page's direction contract lives in `apps/web/.impeccable/surfaces/index-html.md`.

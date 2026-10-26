# New-user journey: less to read, nothing to guess

Status: **done** (2026-10-26).

## Goal

The user (2026-10-26): "Improve the product feel and usage. Today it is difficult for new joiners. Make it less verbose
and more intuitive; the journey should have no friction. List the things a new user would really like and the things
that will confuse them, then address them."

An impeccable critique of the journey from the landing page to an exported crown scored it **24/40**. It found one P0,
three P1 and two P2 issues. Snapshot: `.impeccable/critique/2026-10-26T09-08-48Z__apps-web-src-ui-app-tsx.md`. The
detector found no mechanical problems: the friction is in the flow and the words.

## Decisions (user, 2026-10-26)

| Question | Answer |
|---|---|
| Tooth chart layout | Dentist's view: 18…11 \| 21…28 over 48…41 \| 31…38, as if facing the patient |
| Product name on the landing page | "Dental CAD" everywhere for now, the name the editor already shows |
| How far to go | Simplify the current flow. Keep the nine exocad-style steps; no separate guided mode |

## What a new user would really like

**Already there (keep):**
- The demo needs no account, and one click gives a crown in about 2 s with a live checklist.
- Accept/Reject keeps or discards the whole run as one undo step.
- "Ready to mill" lists real values with their limits.
- "Go to Tooth frame" fixes a skipped step in one click.
- Parameter errors give the allowed range.
- Colour legends mark contact and target.

**Missing (add):**
- The tooth to click marked in 3D, with the camera looking at it.
- "All checks passed" as one line, with the proof one click away.
- A confirmation you can see after Accept, Reject and Undo.
- A scan checklist.
- A help sheet with the shortcuts and the terms.
- An ending after the export.
- The demo as an obvious button on the landing page.

## What confuses a new user (and the fix)

| # | Sev. | Confusion | Fix |
|---|---|---|---|
| 1 | P0 | The demo opens on a low side view where 36's prep is hidden. A click lands on 35, auto-design runs there and fails with "Kink … 174°" ×5, and Accept plus a blue Next are still offered. | Tooth frame opens looking down onto the prep's jaw. In the demo a blue ring marks the prep of 36, and a click outside it is refused in plain words. A stopped draft makes Reject the primary action and explains the stop plainly. |
| 2 | P1 | The draft review is 2,073 px and 378 words (232 of them a check log such as "Frame axes are orthonormal (0, limit 0)"), with Accept next to a blue "Next: Adapt". Finalize says "Ready to mill" before the draft is accepted. | One line ("Draft ready: all 18 checks passed"), with the checks and the reasoning behind "Show the checks". Accept is the only primary while a draft is open. Finalize waits for Accept or Reject. |
| 3 | P1 | Messages render at the end of a scrolling panel: "Draft accepted" landed 310 px below the window, and the Ctrl+Z refusal was never seen. | The status line sits above the step footer, always in view. |
| 4 | P1 | Jargon with no help layer: "Swap mesial and distal", "Source: automatic", "Least undercut / From view", "Extra spacer", "Gizmo", "Orthographic", "Construction info". No shortcut sheet; the shortcuts are spread over three places. | One plain sentence per step, and details folded away. A help sheet (the `?` key, or Help in the toolbar) with the shortcuts and a short glossary. |
| 5 | P2 | Case setup: "Continue offline" lands on Scans with 36 already marked done; the chart isn't a dentist's chart; a click on 46 adds a second tooth; every tooth gets Crown \| Inlay \| Onlay \| Implant \| Pontic plus Anatomic \| Reduced; the Parameters values are repeated read-only. | Offline starts at Case setup. Dentist's-view chart with Right and Left marked. "Click a tooth to add or remove it" in the hint. Crown \| Pontic \| More types. The duplicate parameters go. |
| 6 | P2 | Wordy panels: Parameters has 92 words of help; Proposal, Adapt and Axis open with 31–35 word paragraphs; Scans says "already in occlusion" and "Pre-op" unexplained, and keeps offering demo scans after they are loaded. | Shorter hints (Parameters ≤ 8 words each), one-sentence intros. Scans: a checklist of the jaws; demo scans only while the case has none. |
| 7 | P2 | Landing: "[Product name]" in the header, title and footer; the scope list says "Bridges are next"; the checks counter can end on "4 of 5 passed" with five ticks; the demo is a small text link. | "Dental CAD". Scope list updated. The counter counts the passed rows. "Try the demo" as a button in the hero and the header. |
| 8 | P3 | Parameters and Finalize never turn done, so the journey ends on open rings. The viewport hint line drops to 1.2–2.2:1 over the scan. Uppercase "SIGN IN" against DESIGN.md's sentence-case rule. "Case reference" vs "Patient reference". | Parameters shows done once a crown uses them; Finalize after an export. The hint gets a panel-tinted backdrop. Sentence case. One term, "Case reference". |

## Scope

**In:** the fixes in the table above, in the editor (`apps/web/src/ui/**`, `apps/web/src/tools/controller.ts`,
`state/session.ts`, `styles.css` and the step CSS) and on the landing page (`apps/web/index.html`,
`apps/web/src/landing/`). Plus `DESIGN.md` for the editor parts that change (tooth chart, status line, help sheet), and
the browser scripts whose selectors change.

**Out:**
- A separate guided mode (the user chose to simplify the current flow).
- Renaming steps: "Tooth frame" stays; each step gets a plain sentence instead.
- A general wrong-tooth detector for real scans. Only the demo knows where its prep is. Real cases get the occlusal
  view and a plain explanation when the margin check fails.
- Keyboard Accept/Reject, sculpting, the assistant panel offline.
- The API (no server changes).

## Design

### First click (Tooth frame)
- **Camera:** entering Tooth frame on a tooth with no frame looks down onto the prep's jaw: from above for the lower
  jaw, from below for the upper. This happens after the antagonist is hidden, so the jaw fills the view. It uses a
  new `Viewer.viewJaw(jaw)`, alongside `setView`.
- **Demo marker:** while the demo is open and 36 has no frame, a 26 px blue ring marks the top of 36's prep
  (`syntheticPrepSeed` at the demo scan's resolution). The demo scan's resolution moves from `geometry.worker.ts` to a
  shared `DEMO_SCAN` constant in `geometry/synthetic.ts`.
- **Demo guard:** in the demo with one-click armed, a click more than 4 mm from the prep's top (in the occlusal plane)
  is refused: "That is not tooth 36. Click the prepared tooth inside the blue ring."
- **Hint:**
  - Demo: "Click the prepared tooth inside the blue ring. Auto-design proposes the crown for you to review."
  - Elsewhere: "Click the top of the prepared tooth {fdi}." The one-click checkbox stays.

### Draft review (`ui/ai/AutoDesign.tsx`)
- **Header line:** "Draft ready: all N checks passed" or "Draft stopped at {step}". Then one plain sentence on what
  happened and what to do. For a stopped margin: "The margin was not found cleanly. If you clicked the wrong tooth,
  reject and click the prep; otherwise reject and trace the margin yourself."
- **Checks:** passed checks and the rationales sit behind "Show the checks (N)". A failed step's failing checks stay
  visible.
- **Buttons:**
  - A complete draft: Accept is primary, then Reject.
  - A stopped draft: Reject is primary and comes first, then "Keep the passed steps" (secondary).
- **Footer:** while a draft is open, Next is never primary, and the footer's own Accept/Reject follow the same rule.
- **Finalize** shows "Accept or reject the auto-design draft first", with no readiness list and no export, while a
  draft is open.
- **After Accept:** the status line says "Draft accepted. Undo (Ctrl/⌘+Z) takes it back in one step.", and the panel
  scrolls to the top.

### Status line (`ui/ToolStatus.tsx`)
Rendered by `App` between the step panel and the step footer, so it is always in view. Busy and message share one
line. Messages dismiss with ×, and a new message replaces the old one.

### Words
- One sentence per step intro, at most about 20 words. Longer explanations move into a "How it works" disclosure
  where the detail matters to experts (Axis, Proposal, Adapt).
- Parameters hints are cut to a few words each.
- Out of the default view:
  - provenance ("Source: automatic"; the axis "Source");
  - "Control points";
  - template ids;
  - "Synthetic, ~1.3M triangles".
- The Margin footnote of shortcuts moves into the help sheet.

### Help sheet (`ui/HelpSheet.tsx`, new)
- Opens with `?` (Shift+/) or a Help button in the toolbar, and closes with Esc or ×.
- A non-modal panel over the viewport (not a modal dialog) with two short lists:
  - **Shortcuts:** views 1–5, F, O, Ctrl/⌘+Z, Shift+Ctrl/⌘+Z, the margin keys and the nudge keys.
  - **Terms**, one line each: prep, margin, tooth frame, insertion axis, undercut, antagonist, cement gap, pontic,
    connector, colour maps.
- The viewport hint line becomes "Drag to rotate · right-drag to pan · scroll to zoom · ? for help", on a 90% panel
  backdrop.

### Case setup
- **Chart** (`ui/ToothChart.tsx`, `ui/bridge.css`):
  - One row per jaw in dentist's view: 18…11 | 21…28 above 48…41 | 31…38.
  - "Right" and "Left" are marked above the row ends (the patient's sides), with a midline gap.
  - Connectors sit between neighbouring teeth: in a row under the upper teeth and above the lower teeth, with 11–21 and
    41–31 at the midline.
  - Keys stay at least 24 px wide: the side panel widens to 420 px on Case setup only (`.app.wide-panel`).
- **Restoration type:**
  - Crown | Pontic | "More types". More types opens Inlay, Onlay, Wing, Implant and the Anatomic | Reduced switch.
  - It starts open when the unit already uses one of those types.
- **Removed:** the read-only "Parameters for 36" block (the Parameters step shows the same values).
- **Hint:** "Click a tooth to add or remove it. Mark a missing tooth as a pontic to make a bridge."
- **"Case reference (no patient names)"** in both places.
- **"Continue offline"** opens Case setup, not Scans.

### Scans
- A checklist: "{Lower} jaw with the prep: loaded / missing" and "{Upper} jaw, the opposing teeth: loaded / missing".
  It replaces the paragraph and the amber warning.
- "Import as" keeps its options, with "Pre-op scan (before the prep)" spelled out.
- "Load demo scans" only while the case has no scans.

### Ending
- **After an export**, Finalize shows "Exported {file}" and the next actions:
  - Offline or demo: "Create an account to save cases" (sign-up) and "Start your own case" (an empty offline case).
  - Signed in: "Back to cases".
- **The rail:**
  - Parameters shows done once the crown is proposed.
  - Finalize shows done after an export of the current design in this session.

### Sign-in and landing
- **Sign-in:**
  - Sentence-case headings.
  - "Try the demo case" first in the no-account group, with one line each: "Try the demo case: a ready-made case,
    one click to a crown" and "Continue offline: start an empty case, nothing is saved".
- **Landing:**
  - "Dental CAD" replaces "[Product name]" in the title, wordmark and footer.
  - "Try the demo" as a secondary button beside the hero form and in the header.
  - The scope lists match today.
  - `runChecks` counts the passed rows instead of using the row index.

## Verification plan

- `pnpm typecheck`, `pnpm test`, `pnpm --filter @dcad/web build`.
- **Tests:** none added. These are UI flow and copy changes, which the test rules exclude (labels, text, timing), and
  the demo guard is a distance check covered by the browser test below. The suite stays at 111.
- **New browser test** `tools/e2e/first-run.mjs` (offline, headless Chrome):
  - The demo opens Tooth frame with the blue ring projected inside the viewport.
  - A click on 35 is refused, and nothing runs.
  - A click inside the ring gives a draft whose review is one line with the checks collapsed, and Accept as the only
    primary.
  - After Accept, the status line is inside the window.
  - Finalize → Export shows the ending.
  - `?` opens the help sheet.
  - "Continue offline" opens Case setup with the dentist's-view chart (18 left of 11, 21 right of 11).
- **Every existing browser script passes**, updated where a selector changed:
  `offline-design`, `crown-move`, `bridge`, `ai-bridge`, `implant`, `maryland`, `anterior-export`, `framework`,
  `inlay`, `ai-implant`, `ai-maryland`, `ai-framework`.
- **Before and after numbers** from the same measurement script:
  - visible explanatory words per step;
  - draft-review height;
  - controls on Case setup;
  - the hint's contrast over the scan.
- A re-run of the impeccable critique scores the journey against 24/40.

## Implementation summary

Every row of the confusion table is addressed. The journey stays in the nine steps; nothing is hidden that an expert
needs, only folded or moved.

**What was built, and where**
- **First click.** `Viewer.viewJaw` looks down onto the prep's jaw, applied by `tools/controller.ts` on entering Tooth
  frame without a frame, after the antagonist is hidden. `tools/demoPrep.ts` holds the demo's prep (the
  `syntheticPrepSeed` at the new shared `DEMO_SCAN` resolution in `geometry/synthetic.ts`, also used by the worker),
  the ring and the guard. The ring is drawn by the controller, and the guard runs in `frameTool.ts`'s seed click,
  which also clears an earlier message.
- **Draft review** (`ui/ai/AutoDesign.tsx`).
  - One `Review` serves both the step panel and the footer.
  - It shows the verdict line, a plain next action for each failed step (`nextAction`), the failing checks, and the
    buttons.
  - "Show the checks (N)" folds the full log and the rationales.
  - `useDraftOpen` (a proposer transaction, running or in review) demotes the footer's Next and "Go to", and blocks
    Finalize.
- **Status line.** `ui/ToolStatus.tsx` now renders in `StepFooter`, with dismiss. An info message leaves with its
  step. Styles are in `ui/StepFooter.css`.
- **Help.** `ui/HelpSheet.tsx` and `.css` give 11 shortcuts and 13 terms, including mesial/distal and buccal/lingual,
  which the panels use throughout. It opens with `?` or Help in the toolbar and closes with Esc. The viewport hint is
  shorter and sits on a 94% panel ground.
- **Case setup.**
  - `ui/ToothChart.tsx` and `ui/bridge.css`: the dentist's-view rows with Right, Left, Upper and Lower, a 24 px pitch
    and a midline gap.
  - `.app.wide-panel` (420 px) applies on Case setup only.
  - `SetupStep.tsx`: Crown | Pontic | More types; the duplicate parameters are gone; "Case reference (no patient
    names)"; a one-line hint.
  - `goOffline` opens Case setup.
- **Words.**
  - Frame, Axis, Proposal (crown, implant, bridge), inlay, Adapt and Parameters are cut to one sentence or a few words.
  - Removed: "Source", "Control points", "Synthetic, ~1.3M triangles" and the second "Load demo scans".
  - "From view" became "Along my view".
  - Scans is a checklist (`ScansStep.tsx`, `.scan-checklist`), and "Pre-op scan (before the prep)" is spelled out.
- **Ending.** `state/exported.ts` records each export from `crownTool.export` (STL) and Export all. The rail
  (`StepNav.tsx`) shows Finalize done for the exported teeth while the document is unchanged, and Parameters done once
  the proposal is. `FinalizeStep.tsx` adds `JourneyEnd`:
  - offline: "Create an account" and "Start your own case" (`signUpFromOffline` and `startOwnCase` in
    `state/session.ts`);
  - signed in: "Back to cases".
- **Sign-in and landing.**
  - Sign-in (`AuthForm.tsx`, `session.css`): sentence-case headings; "No account needed" with "Try the demo case" and
    "Continue offline", one line each.
  - Landing (`index.html`, `landing.css`, `landing.ts`):
    - "Dental CAD" in the title, wordmark and footer;
    - "Try the demo" in the header and under the hero form (it follows the form on mobile);
    - the scope lists match what has shipped;
    - the checks counter counts passed rows.
- **DESIGN.md:**
  - status line, help sheet, hint ground, Case setup panel width;
  - the Draft Review and First Click components;
  - the dentist's-view chart;
  - Next is never primary during a draft;
  - the rail statuses;
  - the wordmark without its placeholder outline.

**Deviations from the spec**
- **"Keep the draft", not "Keep the passed steps":** Accept also keeps the failed step's output, so it can be fixed by
  hand. The label says what it does. When nothing passed (a failed frame), only Reject is offered.
- **No "How it works" disclosures:** one short sentence was enough on Axis, Proposal and Adapt, so nothing was folded.
- **No scroll to the top after Accept:** the status line already puts the confirmation in view.
- **Guard distance:** 5.5 mm in 3D from the prep's top, with a ring radius of 4.5 mm, instead of 4 mm in the occlusal
  plane. A click anywhere on the prep's top or shoulder passes, and 35's and 37's centres are about 9 mm away.
- **Draft open:** "a draft is open" includes a running draft (the proposer's transaction), not only one in review.
  Otherwise Next turned primary for the run's two seconds.
- **Landing wordmark:** the dashed placeholder outline was removed with the placeholder name, and DESIGN.md is updated
  to match.
- **Domain words kept:** "Swap mesial and distal", "Least undercut" and the tilt and nudge directions are dental
  technicians' own words. The glossary explains them instead.
- **Critique not re-run:** the impeccable critique was not run again. The before and after numbers below use the
  critique's own measurement script instead.

**Verification**
- `pnpm typecheck` clean. `pnpm test`: 111 tests (99 pass, 12 skipped without infrastructure), unchanged: this task
  adds none (see the verification plan). `pnpm --filter @dcad/web build` passes; its chunk-size warning predates the
  task.
- Fixtures regenerated in the main checkout (`fixtures`, `fixtures:implant`, `pipeline-runner run --synthetic`:
  8/8 runs passed).
- **Browser scripts:** every one passes against the dev server.

  | Script | Checks passed |
  |---|---|
  | `first-run` (new) | 19 |
  | `offline-design` | passes (prints no check count) |
  | `crown-move` | 30 |
  | `bridge` | 34 |
  | `ai-bridge` | 16 |
  | `implant` | 32 |
  | `maryland` | 16 |
  | `anterior-export` | 13 |
  | `framework` | 22 |
  | `inlay` | 23 |
  | `ai-implant` | 14 |
  | `ai-maryland` | 8 |
  | `ai-framework` | 7 |

  - Six scripts open "More types" first (`moreTypes`).
  - `first-run` measured:
    - the arrival view looks down at cos 0.96;
    - the ring is inside the viewport;
    - the click on 35 is refused;
    - "Draft ready: all 18 checks passed", with 0 checks visible;
    - Accept is the only primary;
    - the confirmation is inside the window;
    - Parameters and Finalize are done;
    - the chart's teeth are 22 px on a 24 px pitch.
- **Before and after**, with the critique's script (`s2-demo`, 1400 × 900), on the comparable states:

  | State | Explanatory words | Panel words | Panel height (px) |
  |---|---|---|---|
  | Demo arrival (Tooth frame) | 35 → 16 | 43 → 24 | 859 → 859 |
  | Case setup | 28 → 19 | 123 → 87 | 1,119 → 859 (no scroll) |
  | Scans | 33 → 10 | 87 → 81 | 928 → 901 |
  | Parameters | 92 → 63 | 123 → 94 | 1,146 → 1,059 |
  | Draft review (Crown proposal) | 156 → 65 | 378 → 124 | 2,073 → 1,236 |
  | Draft on Margin (footer review) | 48 → 52 | 49 → 22 | 859 → 859 |
  | Margin, after Accept | 37 → 17 | 38 → 22 | 859 → 859 |
  | Insertion axis, after Accept | 39 → 17 | 57 → 40 | 859 → 859 |
  | Adapt | 74 → 54 | 108 → 95 | 1,136 → 1,022 |
  | Finalize | 26 → 19 | 116 → 116 | 1,056 → 978 |

  - The draft review's remaining height is the crown read-out and the adjust controls below it, not the review.
  - On Margin, explanatory words rose by 4 because the footer review now says what to do.
  - Accept's confirmation was at y = 1,210 in a 900 px window before; it now sits in the footer.
- **Contrast:** the viewport hint is now at least 4.76:1 even over a black surface (it was 1.2–2.2:1 over the mesh).
- **Design detector:** `impeccable detect` finds 0 anti-patterns in the changed files, and none on the live landing
  page or `/app/`. Its one advisory, a straggling word in the new scope list, is fixed.

**Follow-ups**
- Re-run `/impeccable critique` to score the journey, then close the 2026-10-26 snapshot.
- Re-shoot the landing assets with `tools/e2e/landing-shots.mjs`: the hero's draft-banner capture shows the old review
  wording.
- **Wrong-tooth help for real scans:** only the demo knows where its prep is. A prep detector could ring the prep on
  any scan.
- Help sheet entries for the colour-map names (occlusal and proximal clearance, unmillable).
- **QA wording:** proposer check messages such as "Frame axes are orthonormal" are still engineering wording, inside
  "Show the checks".

---
target: new-user journey (landing and editor)
total_score: 29
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/Users/rishabhchaudhary/experiments/apps/web/src/ui/App.tsx"
target_fingerprint: "sha256:eb5bfe43484d4e60ed03125d6ee304bb6c56eb4e7718fa5eb793630cf93c8c9a"
target_path: /Users/rishabhchaudhary/experiments/apps/web/src/ui/App.tsx
timestamp: 2026-10-26T12-40-15Z
slug: apps-web-src-ui-app-tsx
---
# New-user journey critique, re-run (landing → demo → first crown → export)

Method: dual-agent (A: design review sub-agent · B: detector + browser sub-agent). Same journey and target as
2026-10-26T09-08-48Z, after commits 86acde6, 9a5be07, 8b7a7f5, ea28893 and 1dfb5c8.

## Design Health Score
| # | Heuristic | Was | Score | Key Issue |
|---|-----------|-----|-------|-----------|
| 1 | Visibility of System Status | 3 | 3 | Status line now in view (y 806–852). After Undo it still says "Draft accepted…", and during the run the rail shows five steps done before a draft exists. |
| 2 | Match System / Real World | 2 | 3 | Clinical terms used well, and the refusal names the tooth. Inside "Show the checks": "(0, limit 0.06)", "(42.79, limit 120)", "share of the way round (1, limit 0.75)". |
| 3 | User Control and Freedom | 3 | 3 | Accept/Reject plus one-step undo. After Reject or Undo the user is left on Crown proposal with no crown and contradictory prerequisites. |
| 4 | Consistency and Standards | 2 | 2 | Two primaries on Insertion axis, after export, and on offline Case setup. 5 / 18 / 7 checks across landing, draft and Finalize. Thickness limit 0.48 vs 0.50. "Revert" on the landing, "Reject" in the app. |
| 5 | Error Prevention | 2 | 3 | A click on 35 is refused and nothing runs. Undo is blocked mid-draft with a reason. Finalize waits for Accept. The sign-in form stays live while the server is down. |
| 6 | Recognition Rather Than Recall | 2 | 3 | The ring marks the prep. Labelled views, rail statuses, the hint line. Undo and redo are icon-only. |
| 7 | Flexibility and Efficiency | 3 | 3 | Views 1–5, F, O, nudges, 1.7 s auto-design, rail jumping. No keys for Accept, Reject or Next. |
| 8 | Aesthetic and Minimalist Design | 2 | 3 | Arrival is 72 words and one action. The draft review is still 27 controls, 205 words and 1,219 px. |
| 9 | Error Recovery | 3 | 3 | "That is not tooth 36. Click the prepared tooth inside the blue ring." is exemplary. Signing in with the server down shows a raw "Bad Gateway". |
| 10 | Help and Documentation | 2 | 3 | Help sheet (? or toolbar): 11 shortcuts, 18 terms. Same on every step, not searchable, and the last term is clipped. |
| **Total** | | **24** | **29/40** | **Good** (was Acceptable) |

## Design Specificity Verdict
**LLM assessment:** authored for this product, with generic seams.
- **Specific:**
  - the exocad nine-step rail;
  - the blue ring on 36's prep, and a refusal by tooth number;
  - the clearance legend's 0 mm contact tick and dotted 0.05 mm target tick;
  - "Ready to mill" rows with values and limits;
  - the dentist's-view FDI chart;
  - the landing and the app showing the same draft moment.
- **Generic:** sign-in (form plus render) and the export ending ("Exported." plus two buttons).
- **Missed character:** the viewport never carries a verdict. The refusal, Accept, Undo and Export all speak only in the panel footer.

**Deterministic scan:**
- **CLI:** `detect` on `apps/web/src/ui` and `apps/web/index.html` exits 0. It finds 0 primary and 4 advisory findings, and all 4 are false positives: each value is documented in DESIGN.md's prose but missing from its token frontmatter.
  - `bridge.css:84`: 14% black into the accent on hover;
  - `bridge.css:134` and `bridge.css:143`: 4px connector-bracket corners;
  - `session.css:53`: the 28px session display heading.
- **Browser overlay:** run on landing, sign-in, Tooth frame, the draft review and Finalize. The first four are clean. Finalize has 1 straggler: "checks." alone on its last line, in the export note (`steps/FinalizeStep.tsx:197`). It is a true positive and P3.
- **Contrast** (pixel-measured):
  - viewport hint 5.60:1 (was 1.2–2.2:1);
  - status line 15.4:1;
  - legend text 5.4–16.9:1;
  - white-on-blue primary 4.72:1 (passes, narrowly).
- **Agreement:** the two assessments agree there is no mechanical or visual-system problem left. What remains is flow and state, which the detector cannot see.

**Visual overlays:** injected through headless Playwright. There is no user-visible [Human] tab; the overlays appear only in the run's screenshots.

## Fixed since the last run
- The P0 first click is fixed: the arrival looks down on the jaw, a ring marks 36, a click on 35 is refused, and nothing runs.
- The draft review:
  - shows one verdict line ("Draft ready: all 18 checks passed") with the checks folded;
  - has Accept as the only primary;
  - makes Finalize wait for Accept or Reject;
  - has 205 panel words, down from 378.
- Feedback sits in a status line inside the window.
- There is a help sheet.
- The landing's name placeholder and checks counter are fixed, and "Try the demo" is a button.
- Case setup opens offline, with a dentist's-view chart.
- The hint contrast passes.

## Priority Issues
- **[P1] Undo and Reject strand the user in contradictory state.**
  - **What:** after Undo of an accepted draft, five things appear together:
    - the status line still says "Draft accepted. Undo (Ctrl/⌘+Z) takes it back in one step.";
    - the panel says "Set the insertion axis first.";
    - the footer says "This step needs Tooth frame first." with a "Go to Tooth frame" primary;
    - the "Occlusal clearance" legend floats over a scene with no crown;
    - the camera stays on the proposal close-up, so the ring is out of sight.

    Reject gives the same picture under "Draft rejected…".
  - **Why it matters:** this is the "user decides" guarantee, and its exit is the most confusing moment in the journey.
  - **Fix:**
    - return to the step the run started from (Tooth frame, its camera and the ring);
    - replace the stale message ("Undone: auto-design");
    - name one earliest missing step;
    - hide the legend when there is no crown.
  - **Suggested command:** $impeccable harden
- **[P1] The draft's checks disagree with the product's own numbers.**
  - **What:**
    - The draft gates thickness at "limit 0.48" (`ai/qa.ts:79` subtracts an unnamed 0.02 tolerance), while Parameters and Finalize say "Zirconia minimum 0.50 mm".
    - The landing says "five measured checks", the draft says 18, and Ready to mill lists 7.
    - Four checks repeat: "closed all the way round", watertight, self-intersections and thinnest point.
    - Values are bare: "(42.79, limit 120)" and "(1, limit 0.75)".
  - **Why it matters:** technicians judge a design by these numbers. Two minimums for one material make the gate look arbitrary.
  - **Fix:**
    - lead with Ready to mill's 7 clinical rows in "1.01 mm, min 0.50" form;
    - fold the geometry gates into a sub-disclosure;
    - drop the duplicates;
    - name the tolerance;
    - align the landing's count.
  - **Suggested command:** $impeccable clarify
- **[P2] The draft decision is buried in a full editing panel.**
  - **What:**
    - 27 controls, 205 words and 1,219 px of scroll; 486 words and 2,163 px with the checks open.
    - "Re-propose crown" sits above the verdict and is live, and so are the move, rotate and scale controls.
    - The gizmo covers the centre of the occlusion map.
  - **Fix:**
    - during review, show only the verdict, one sentence, Accept/Reject and the measured rows;
    - offer editing after the decision ("Keep and adjust");
    - hide the gizmo.
  - **Suggested command:** $impeccable distill
- **[P2] After Accept, the next step is wrong and success goes unsaid.**
  - **What:**
    - The primary becomes "Next: Adapt", a step the draft already did.
    - The confirmation never says the design is ready to mill.
    - "Re-propose crown" and "Auto-design crown" both remain.
  - **Fix:**
    - make the primary "Review and export" (go to Finalize);
    - make the message "Draft accepted: ready to mill (7 of 7)";
    - hide Auto-design once a crown exists.
  - **Suggested command:** $impeccable onboard
- **[P2] Feedback lands far from the action, or out of view.**
  - **What:**
    - The 35 refusal appears bottom-left (y 806–852), about 900 px from the click, and the scene does not react.
    - After export, the file line is at y 898–916, under the sticky footer. The ending card names no file.
    - Export STL stays primary beside "Create an account".
  - **Fix:**
    - echo the refusal at the pointer, or pulse the ring;
    - put the file name and format in the ending card;
    - demote Export after export.
  - **Suggested command:** $impeccable polish

## Other issues
- **P2:**
  - Signing in with the server down shows a raw "Bad Gateway". Sign in stays the only primary, and the working paths (demo, offline) are secondary.
  - During the run, the rail shows Tooth frame through Crown proposal done before any draft exists.
  - The mid-run hint invites re-clicking the prep, and the one-click checkbox silently unchecks.
  - Insertion axis has two primaries ("Least undercut" at `steps/AxisStep.tsx:35`, plus "Next: Parameters").
  - Two primaries after export, and on offline Case setup ("Next: Scans" and "Load demo scans").
  - The crown's Design Blue matches the map's ≥0.5 mm blue, so map on and map off look alike. In Finalize the opaque antagonist hides the occlusal surface while the legend reads "Occlusal clearance".
  - Help is the same on every step, with an internal scroll over the scene.
  - "Re-propose crown" vs "Auto-design crown" is unexplained.
  - "Continue offline" (an empty case) arrives with 36 / Crown / Zirconia preselected.
  - "More types" mixes types (Inlay, Onlay, Implant) with a crown variant (Anatomic, Reduced).
  - The legend shows with no crown.
- **P3:**
  - "More types" has no button affordance.
  - Adapt's targets have no unit.
  - "Spacer starts at 1" vs two decimals elsewhere.
  - The insertion-axis arrow uses the distal purple.
  - Check values are not in "value unit, limit" form.
  - An amber "Offline" badge in the demo.
  - "Accept or revert" on the landing.
  - "Next: Margin" on arrival leads to an empty step.
  - The help sheet's last term is clipped.
  - About 9 px type in the landing hero's inset crop.
  - Icon-only undo and redo, and 15 toolbar controls for a demo user.
  - The Finalize straggler.

## Cognitive Load
- **4 of 8 checklist items fail:** single focus, chunking, one thing at a time and minimal choices. Nearly all of the load is in the draft-review state; arrival, Margin and Axis are light.
- **Decision points with more than 4 options:**
  - draft review: 27 controls;
  - accepted Crown proposal: 25;
  - Case setup: 49, including 32 tooth keys;
  - "More types" expanded: 8;
  - Adapt: 7;
  - Axis: 6;
  - toolbar: 15.

## Emotional Journey
- **Peak:** clicking the prep, then 1.7 s of ticking steps, then the crown on the occlusion map with "Draft ready: all 18 checks passed".
- **Valleys:**
  - "Bad Gateway" at sign-in;
  - the misclick answer far from the eyes;
  - the crowded review;
  - three disagreeing messages after Undo or Reject.
- **End:** flat. "Exported." without the file in view.
- **Reassurance:** strong before Accept and before Export, weak after both.

## Persona Red Flags
- **Jordan, the first-timer:**
  - At /app/, the only primary is Sign in, and it returns "Bad Gateway".
  - The 35 refusal is bottom-left while the eyes are on the ring.
  - The first button read is "Re-propose crown".
  - "Show the checks" opens 285 words of gate language.
  - After Accept, "Next: Adapt" offers three Adapt buttons.
  - Reject shows "Set the insertion axis first" and "This step needs Tooth frame first" together.
  - The file name is never seen.
- **Chairside clinician:**
  - "Tooth frame", with axis arrows and "Swap mesial and distal", is explained only in Help.
  - "Along my view" needs camera literacy.
  - The checks read as QA language.
  - The zirconia draft passes at "limit 0.48".
  - "Anatomic | Reduced (metal framework)" is a framework concept.
- **Alex, the exocad power user:**
  - No key for Accept, Reject or Next.
  - The post-Accept primary walks back through finished steps.
  - 18 checks with duplicates and two thickness limits.
  - The occlusion map is covered by the gizmo during review and by the antagonist in Finalize.
  - Works well for him: views 1–5, F and O, 0.1/0.5 mm nudges, rail jumps, one-click Least undercut.

## Minor Observations
- The hint line, the shape-coded rail statuses (with screen-reader text), the coherent dark theme and the honest amber notice at sign-in all work.
- The 420 px Case setup panel fits the 24 px chart pitch.
- DESIGN.md's token frontmatter lags its prose: the 28px display, the 4px bracket radius and the hover mix are missing from it. That lag causes all four advisory findings.

## Questions to Consider
- What if an open draft owned the whole panel (verdict, the measured rows, Accept), with editing only after "Keep and adjust"?
- What if the viewport carried the verdicts: the refusal at the click, the thinnest point pinned on the crown, a visible "kept" state?
- What would a technician lose if the draft showed only Ready to mill's seven rows, and the gates became a developer log?

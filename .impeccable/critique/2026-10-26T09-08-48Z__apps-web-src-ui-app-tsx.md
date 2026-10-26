---
target: new-user journey (landing and editor)
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 3
target_identity: "file:/Users/rishabhchaudhary/experiments/apps/web/src/ui/App.tsx"
target_fingerprint: "sha256:3560584df6b5e9dd7a41e668304e74c73b3921e7e56482cf462f0148a6a93629"
target_path: /Users/rishabhchaudhary/experiments/apps/web/src/ui/App.tsx
timestamp: 2026-10-26T09-08-48Z
slug: apps-web-src-ui-app-tsx
---
# New-user journey critique (landing → demo → first crown)

Method: dual-agent (A: design review walkthrough · B: detector + browser evidence)

## Design Health Score
| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Tool messages render below the fold (Accept confirmation at y=1210 in a 900 px window) |
| 2 | Match System / Real World | 2 | Pipeline terms in the UI: orthonormal, FDI handedness, radial profiles, (0, limit 0), template ids |
| 3 | User Control and Freedom | 3 | Undo, Accept/Reject, Cancel work; a failed draft still offers Accept and a primary Next |
| 4 | Consistency and Standards | 2 | Two primaries during a draft; Case vs Patient reference; uppercase session labels |
| 5 | Error Prevention | 2 | One-click runs on any tooth clicked; unaccepted draft shows Ready to mill |
| 6 | Recognition Rather Than Recall | 2 | The target tooth is not marked in 3D; shortcuts scattered in three places |
| 7 | Flexibility and Efficiency | 3 | Good view and nudge keys; none for Accept/Reject or Next/Back |
| 8 | Aesthetic and Minimalist Design | 2 | Draft review panel 2,073 px / 378 words; accepted Proposal ~28 controls |
| 9 | Error Recovery | 3 | Specific fixes; wrong-tooth click misreported as margin kinks |
| 10 | Help and Documentation | 2 | No help, glossary or shortcut sheet |
| **Total** | | **24/40** | **Acceptable** |

## Design Specificity Verdict
The editor's step rail, gated one-click auto-design and Ready-to-mill list are specific to this product. The newcomer interaction is engineering-led: paragraphs, raw QA logs, no in-scene guidance. Detector: 0 primary findings; advisory flat type hierarchy (intentional per DESIGN.md), 3 token advisories (2 false positives); browser contrast pass missed the viewport hint over the mesh (1.2–2.2:1).

## Priority Issues
- [P0] Demo first click: prep hidden in the arrival view; a misclick runs auto-design on the wrong tooth; failure reads as margin kinks with Accept and a primary Next. Fix: frame and mark the target tooth, refuse a non-prep click in plain words, Reject as the default on a failed draft.
- [P1] Draft review wall: 232-word check log, competing primaries, Finalize says Ready to mill before Accept. Fix: one-line summary with details collapsed, one primary, block Finalize until accepted.
- [P1] Feedback off-screen: tool messages at the end of a scrolling panel. Fix: a status line that stays in view.
- [P1] Jargon with no help layer. Fix: one plain sentence per step, details behind a disclosure, a ? sheet with shortcuts and terms.
- [P2] Case setup: offline lands on Scans with 36 marked done; a chart click adds a tooth; 5-way type switch plus Anatomic/Reduced; duplicated parameters. Fix: start at Case setup, Crown/Pontic with More types, remove the duplicate.
- [P2] Landing credibility: [Product name] placeholder, outdated scope, checks counter race ("4 of 5" with 5 ticks), demo hidden as a text link.

## Persona Red Flags
- Jordan (first-timer): cannot find 36; misclick yields "Kink … 174°" ×5; Accept next to blue Next; no confirmation after Accept; no ending.
- Chairside clinician: non-anatomical chart; "already in occlusion", "Pre-op", "Extra spacer", "Orthographic", "Gizmo" undefined; shortcuts nowhere to look up.
- Alex (exocad power user): no Accept/Reject/Next keys; Ctrl+Z refusal off-screen; nudge silently accepts a draft; Parameters never turns done.

## Minor Observations
Uppercase session h2s (session.css); placeholder mismatch LAB-2026-014 vs LAB-2026-0142; legend shown before a crown exists; three "Load demo scans" buttons; native confirm on leaving the demo.

## Questions to Consider
- Should the demo open zoomed on 36 with one "Design this crown" action?
- Should the draft lead with one line and keep the proof one click away?
- Does a first-run single crown need all nine steps visible, or three stages that expand?

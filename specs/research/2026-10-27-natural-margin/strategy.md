# Natural-tooth margins: recommended strategy

Proposer, round 2, 2026-10-27.

**Sources** (all in this folder): `holdout-summary.md`, `exp-S2.md`, `exp-S3.md`, `exp-S4.md`, `ux.md`, `scout.md`,
`critique-1.md`.

Also `exp-S1.md` and `s1-sectors.md` (final, with S1's held-out rows in `holdout-summary.md`). `critique-2.md` had
not appeared when this was written.

**How to read the scores:**
- "Held-out" means 24 Teeth3DS+ test-split teeth from 3 new patients, scored once with frozen parameters.
- "Dev" means the 23 real teeth that the experimenters used for development.

## 1. Ship first

**The engine is the S2 crease-weighted random walker.**
- It runs in the margin web worker, in pure TS (about 450 lines from `tools/pipeline-runner/src/natural/s2/harmonic.ts`
  moved to `apps/web/src/geometry/naturalMargin.ts`).
- Settings: β = 8, raw isoline, one re-centring pass.
- It needs no model, no network and no licence, and costs $0.

| Evidence | Walker | Next best | Today's refiner |
|---|---|---|---|
| Held-out correct / usable | **22/24 / 22–23/24** | S2 watershed 21/24; S4 graph cut 19/24; S1 star-cap3 13/24 (frozen star 7/24); S3 valley 10/24 | 0/24 |
| Held-out median of the mean error | **0.07–0.11 mm** | 0.08 mm (watershed, graph cut); 0.14 mm (star-cap3), 0.29 mm (frozen star); 0.19 mm (valley) | 1.50 mm |
| Dev (in-sample) correct | 20–21/23 | – | 0/23 |
| Time per tooth (Node, real density, 9–17k-vertex patch) | **47–80 ms** | graph cut 264 ms; valley 16 ms | 219 ms |
| The crease, not the seeds, places the line | β = 0 → 0/23; β = 2 → 0/23; β = 4 → 7/23; β = 8 and 16 → 20/23 (a plateau, not a tuned point) | – | – |

**Why this one:**
- **Accuracy:** held-out (22/24) matches dev (21/23), so β = 8 was not overfit.
- **Cost:** about 50–80 ms, versus the graph cut's 5× more.
- **Time to ship:** about 3 days. The work list is in `exp-S2.md`:
  1. Start from the click's hit face, not an O(n) scan.
  2. Output adapter: `smoothOnSurface`, then anchors, then `marginFromAnchors` with the concave weight, which gives
     the `loopVertices` that `prepRegion` needs.
  3. Gate.
  4. One passing and one failing test.
- The same solver is the scribble tool (§2).

**Use it for:** one-click on a tooth that case setup marks as natural, or that the prep finder finds unprepared. It
replaces `refineMargin` there; preps keep `refineMargin`.

**Gate (0.5 day). Reject or flag when:**
- the isoline has more than one chain, or does not wind round the axis;
- its length is outside 0.6–1.4× the template perimeter;
- the re-centring shift is above 0.5 mm.

The one held-out failure that is hopeless for the walker (01KK2DER 16: coverage 50%, max 5 mm) produced **4 chains**,
so this gate catches it.

**Fallback (a hypothesis, n = 1):** when the gate fires, run the S4 graph cut (about 300 ms). It is correct on
01KK2DER 16 (0.11 mm). Both methods fail 01KK2DER 36, so this gives at most 23/24. Keep it only if our own scans
confirm it.

**Do not ship:**
- **The S3 valley ring DP as the engine.** It scores 10/24 held-out: front teeth have 1–4 mm undercut excursions
  that top-down rays cannot see.
- **The P10 snake as an always-on pass.** It gains +1 case and ties a "most concave vertex" snap.
- **S1 (the star unwrap) as the engine.**
  - Held-out: frozen 7/24 (0.29 mm). With the |Δφ| cap, 13/24 (0.14 mm) at 119 ms.
  - Dev: 7/23 and 11/23. A per-case oracle pick between the two configs would still reach only 14/23.
  - Its facial sectors are right. Interproximally, at fused contacts, it fails: interproximal p95 1.22 mm, with
    excursions of 2–6 mm.
  - It is the best of all on synthetic (24/32). That ranking reversed on real data, as the critic predicted.
  - **Reuse two parts of it:**
    - the inside probe (§3);
    - S1 as a facial-sector second opinion (Month 1).

## 2. Human-in-the-loop flow (from `ux.md`; simulated, perfect eyes, keystroke-level times)

**The flow:** the auto line appears coloured by doubt. N flies to the next doubtful sector. Two clicks redraw a sector.
Enter accepts. If most of the line is doubtful, a hint says so and offers a 6-click whole redraw.

| Build order | Change | Days | Simulated effect |
|---|---|---|---|
| 1 | Natural-tooth live-wire weight `liveWireWeight(−κ)`, chosen per tooth in the worker's `weightOf` | 0.5 | Whole 4-click redraw: 0/24 → **16/24** correct (16 clicks: 3 → 21/24) |
| 2 | Two-click sector redraw, spliced in as one `setMargin` command (one undo) | 1–1.5 | 89/106 fixed in 20.5 s, versus today's anchor drag: 49/106 in 26 s |
| 3 | Insert and delete an anchor; re-trace only the neighbouring segments | 0.5 | Drag fixes 49 → 70/106 |
| 4 | Doubt heat map, N / Shift+N fly-to, Enter accept, "off all round: 6 clicks" hint | 2 | Full v1b flow: **93/106 fixed in a median 13 s, 4 actions**; 60/60 at 0.2 mm click error; 2.5 s to confirm a good line |
| 5 | Oblique natural-tooth margin view (the occlusal view hides the cervical line) | 1 | Saves about 6 s per whole redraw (assumed) |
| 6 | Scribble seeds on the walker: a tooth or gum stroke becomes a Dirichlet seed, re-solved warm in an estimated 10–30 ms | 2 | Not simulated yet; build it after 1–4 |

**Notes:**
- The doubt map catches 81–91% of bad sectors, but only 32–54% of what it flags is actually wrong. Use it to order
  the fly-to stops, never to skip review.
- **Defer** the Tab alternatives (33/106), the crease-snap brush (26/106) and one-key snap-all (24/106). Naive "snap to
  the nearest concave crease" picks embrasures.
- **Keep P10 only as the magnetic snap when dragging.** Its capture range is about 0.3 mm, and it halves a 0.6 mm
  offset where a vertex snap does not.

## 3. Roadmap

**Weeks 1–2** (1 developer + Claude):
- Walker engine, gate and tests: 3.5 days.
- Frame robustness: 1 day.
  - Under a ±1.5 mm click jitter the walker drops 20 → 9/23, or 15–16/23 with re-centring.
  - Fix, first try: seed the walker's axis and centre from **S1's inside probe** (about 500 horizontal rays,
    re-centred on the midpoints of opposite wall hits). S1 was jitter-proof with it: 7 → 7 real.
  - Second try: take the axis from a PCA of the u ≥ 0.5 region.
  - Target: ≥ 20/23 under jitter.
- HITL items 1–4: about 4.5 days.
- Re-run `ux/simulate.ts` against the shipped code paths.

**Month 1:**
- **Real validation on data that is not Teeth3DS.**
  - Teeth3DS is cleaned and remeshed, has no colour, and is NC-ND.
  - Every in-house crown case contains 10 or more natural teeth, so the 100 in-house cases give about 1,000 teeth.
  - Pre-label them with the walker. Technicians correct them with the v1 flow (about 13 s each, about 4 hours for
    1,000 teeth).
  - Cover at least 3 scanners (Trios, iTero, Medit), raw exports with holes, and PLY with colour.
  - Ship gate: ≥ 85% correct under click jitter.
- **Colour term** for coloured PLYs. Use it as a gate and leak guard first, not as conductance.
  - As walker conductance it added nothing on synthetic (5/8 versus 6/8).
  - As the watershed's relief, usable went 5 → 8/8.
  - There is no public dataset with colour and labels, so it must be validated on our own scans.
- **Ensemble:**
  - Walker first, then the gate, then the graph-cut fallback. Keep the fallback only if our scans confirm the n = 1
    result.
  - Extra doubt signals, neither measured yet against the walker's errors:
    - disagreement between the watershed and the walker;
    - disagreement between S1 and the walker on facial sectors (S1's facial sectors are right, and its confidence has
      Spearman −0.36 against error).
- **Dense scans.** At the synthetic density (43–87k-vertex patches) a solve takes 0.3–2 s. Decimate the patch or
  solve coarse to fine. Measure worker V8 speed against Node.
- **Preps.** Use the gum line as a *soft* prior for the finish-line search, never as a barrier (a subgingival margin
  lies below it). Measure it on `MARGIN_CASES`.

**Quarter:**
- **Learned unary.** Train only on our own or licensed labels from the flywheel: `ProposalEvent` stores the proposal
  and the accepted line. A small per-tooth classifier or a FiboSeg-style 2D U-Net in ONNX Runtime Web feeds the walker
  as its data term. The walker stays as the regulariser.
- **Licensing.**
  - Teeth3DS: local evaluation only. No fixtures, no derived weights.
  - TGNet and CrossTooth have no licence, so we cannot use them.
  - The S4 graph cut is MIT, but its constants were tuned on Teeth3DS. Record a legal view before shipping it as the
    fallback.
  - Partner data agreements for de-identified scans with training consent.
- **Per-jaw segmentation cache** (every tooth at once) for eggshell crowns, the virtual prep and segmentation.
- **Moonshot (tooth-model and gum-model surface fit): real data only.** The synthetic arch *is* that model, so a
  synthetic win proves nothing.

## 4. What I got wrong in round 1

- **Ranked the star unwrap first.**
  - Held-out it scored 7/24 frozen and 13/24 with the |Δφ| cap, against the walker's 22/24.
  - The depth-jump cue alone scored 1/23: the steep upper alveolar wall and palate give no jump at the margin.
  - Rays from inside a tooth pass through a fused contact into the neighbour, so the line climbs to the contact.
  - I had treated undercuts as the main real-scan problem. On these scans, fused contacts and steep gum mattered
    more.
  - For an open scan, rays from inside the tooth see depth jumps, not creases (the critic's point).
  - Synthetic favoured the star (24/32, the best there). That is the ranking reversal the critic predicted.
- **Underrated the walker.** I guessed 0.1–0.25 mm on real scans; it measured 0.07–0.11 mm median and 22/24 held-out.
  Global diffusion over one strong cue beat my multi-stage pipelines. I also guessed β ∈ {2, 4, 8}, but only β ≥ 8
  works.
- **Oversold P10.** I claimed 0.02–0.06 mm from a 0.3 mm start, and a lift for every method. It gained +1 real case,
  and its capture range is about 0.3 mm.
- **P1's details were wrong.**
  - My "below 40% of the drop" rule deleted lower-molar creases, where the lingual profile drops 8 mm.
  - I did not foresee 12–14 mm cliffs past undercuts. They score a concavity of 36, against the crease's 1–8.
  - Experimenter S3 fixed both, and P1 went 5 → 11/23.
- **Ranked colour fourth without checking the data.** No public dataset has colour and labels. The synthetic colour
  is registered to the labels, so it is an oracle. As conductance it added nothing.
- **Neighbour seeds (P13) for fused contacts had no effect.** The crease between neighbouring teeth is concave too.
- **Missed the oracle click.** It is the largest real gap (−5 to −11 cases under jitter), and none of my proposals
  addressed it.
- **Lesson:** rank on real held-out data and cheap ablations (β = 0, jitter, a prior-only control) before ranking on
  ideas. Synthetic is for debugging.

## 5. Open risks

1. **Thin, clean real evidence.**
   - 12 jaws and 47 teeth in total, an effective n of about 12–20.
   - The labels are only good to about 0.2 mm, close to the 0.25 mm "correct" bar.
   - Raw IOS exports (holes, flaps, seams, blood) are untested.
2. **Click and frame robustness.** Jitter costs 5–11 cases until the axis fix lands.
3. **Which line is truth.** At contacts Teeth3DS truth climbs the tooth/tooth edge. Eggshell provisionals need the
   gingival line from papilla to col. Pick one per use case before validating.
4. **Failures are whole excursions of 1–5 mm** (01KK2DER 16 and 36). The gate is tested on only 2 real failures.
5. **Unseen pathology.** Recession creates a second crease 1–3 mm apical. Calculus, restorations next to the tooth,
   and brackets are untested.
6. **UX numbers are simulated.** They come from synthetic cases, perfect eyes and keystroke-level times. A real-scan
   check with a technician is needed.
7. **Speed on dense scans, and in the browser,** is not measured.
8. **Licences:** Teeth3DS is NC-ND, and the graph cut's constants were tuned on it.
9. **critique-2 is pending.** S1 is final (held-out 7–13/24), and it did not change the ranking.

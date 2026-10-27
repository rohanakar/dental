# Finding the gingival margin on natural teeth: proposals

Proposer's draft for the critic, 2026-10-27. All code references are on `main` at `bb35dc9`.

## 1. Framing

The line we need is the **free gingival margin as the scan shows it**: the closed curve where the enamel (or exposed
root) surface meets the soft tissue. It is not the CEJ, and it is not a finish line. Geometrically it is a **concave
crease** (a valley). That is the opposite sign to what `proposeMarginAnchors` and `liveWireWeight` reward, which is why
today's pipeline produces stair-stepped lines of 39–54 mm on these teeth.

On real scans it is hard for six reasons:
- **Soft crease.** Thick gingiva rolls onto the enamel, and scanner smoothing and stitching blur the crease over
  0.2–0.5 mm.
- **Interproximal zone.** The line climbs the papilla (a 1–4 mm scallop, most on anteriors) into the area the scanner
  sees worst, under contact points where neighbouring teeth fuse into one surface.
- **Undercuts.** The cervical third is often undercut from the occlusal direction: the molar buccal bulge, the lingual
  of lower molars, labially leaning incisors. Height-field tricks miss it.
- **Competing valleys.** Fissures, fossae, embrasures and the interproximal col are also concave.
- **Colour.** It is absent in STL files. Where it exists it is blurred by 0.1–0.3 mm, shadowed interproximally, and
  spoiled by blood or specular highlights.
- **Clinical variation.** Recession, calculus, restorations and brackets break the assumptions.

## 2. Benchmark notes (read before tuning anything)

Facts from `apps/web/src/geometry/synthetic.ts` that the benchmark builder and every implementer should know:

- **Very tall wall triangles.**
  - A natural tooth is `z = gum(s) + H·sqrt(1 − r⁴)`, so the wall is vertical at its foot.
  - At the demo grid (1000 × 500: about 0.08 mm along the arch and 0.024 mm across), the last ring of wall triangles
    is **0.8 mm tall bucco-lingually and about 1.7 mm tall mesio-distally**.
  - Define the true boundary as the analytic footprint `r = 1` at gum height, or as the gum-side vertices of
    mixed-label edges. Never use mixed-edge midpoints, or the ground truth itself carries up to about 0.8 mm of 3D
    ambiguity.
  - Curvature at the crease sits in one vertex ring, so 1-ring curvature looks perfect here and will not on real scans.
- **Colour is a height ramp, not a boundary.** `t = min(1, toothHeight / 1 mm)`. A 50% colour threshold lies about
  0.5 mm up the wall. A colour method must use a low threshold or snap to the crease, and must not be tuned on this
  ramp.
- **No real neighbour contacts.** Footprints of neighbouring teeth touch at one point at gum level (`b = 0`). There are
  no contact points higher up and no papillae (the gum is the smooth band `1.5(1 − s²) − 1.5`, scalloping about 1 mm),
  so the fused-contact problem does not exist here.
- **Pure height fields** unless `anteriorLeanDeg` is set. The shear then creates a labial undercut. Always include
  leaned incisor and canine cases, or top-down methods look better than they are.
- **Mesh sizes.**
  - Demo scale: a tooth's local patch (within 8–10 mm) is about 100k–200k vertices.
  - Real intraoral scans: 10k–30k vertices for the same area (0.1–0.2 mm edges).
  - All ms figures below are quoted for both.

**Shared plumbing** (write once, used by most proposals):
- **Case setup:** reuse `prepareCase` in `tools/pipeline-runner/src/marginEval.ts` with `preps: []`. It provides
  positions, the BVH-ordered indices, normals, the `RayCaster`, the frame from `estimateToothFrame` (use `prep: false`
  for natural teeth), and `analyzeSurface`'s graph and curvature.
- **Expected tooth size:** `templateForTooth(fdi).size` (md, bl, height) gives the radii for seeds and search windows.
- **Valley live-wire:** `liveWireWeight(curvature.map(k => -k))` makes concave cheap. Wrap it in a corridor weight
  (return a large cost for a vertex more than 0.3 mm from a given polyline). Then
  `marginFromAnchors(..., anchors every 1.5 mm)` turns any off-vertex polyline into the `MarginTrace` that the app
  needs (`loopVertices` for `prepRegion`) without drifting.
- **Report and gate:**
  - polish the line with `smoothOnSurface` (`marginRefine.ts`);
  - report `sharpestTurnDeg` and `polylineLength`;
  - also measure 3D deviation along the line, not only from it (coverage).

---

## 3. Proposals

### P1. Valley ring DP: flip the sign of the existing pipeline
- **Idea:**
  - Keep the radial height profiles of `proposeMarginAnchors`, but score **concavity** (`after − before` instead of
    `before − after`).
  - Keep every concave peak as a candidate when it lies below about 40% of the profile's total drop. That rules out
    fissures near the top.
  - Pick one candidate per profile with the cyclic DP `ringDpAnchors`. Close the line with the valley live-wire, then
    `smoothOnSurface`.
- **Why it should work:**
  - On a height-field tooth, the deepest strong concave kink before the profile rises onto a neighbour is the
    tooth/gum junction.
  - The ring DP already handles runs of false edges.
- **Failure modes:**
  - Top-down rays cannot see undercut cervical walls. The anchor lands on the gum beside the bulge, 0.3–1 mm off.
  - Profiles toward a neighbour stop at the rise (`riseStopMm`) before the col.
  - Leaned anteriors.
- **Accuracy guess:**
  - Synthetic upright: mean 0.05–0.15 mm, max 0.3–0.6 mm.
  - Leaned or real: mean 0.2–0.5 mm.
- **Cost:** 30–60 ms (the plain margin is 34 ms today). $0.
- **Time to ship:** 1–2 days, almost entirely reuse.
- **Experiment (30 min):**
  - Add a `concave` option to `proposeMarginAnchors` (or copy it as `proposeGumAnchors`): candidates from the concave
    score, `minDropMm` replaced by "≥ 40% of the profile's drop".
  - Run `ringDpAnchors`, then `marginFromAnchors` with the valley weight, then `smoothOnSurface`.
  - Run 16/24/32 profiles on natural 11, 13, 14, 36 and 46, upper and lower, with noise 0.04 and lean 25°.
  - This is the **baseline every other proposal must beat**.

### P2. Star unwrap from inside the tooth, plus circular DP *(top pick)*
- **Idea:**
  - Put a centre point C inside the tooth on its axis, at about 25% of the crown height above the local gum level. Find
    the gum level from 8 top-down rays at 1.2× the expected bucco-lingual half-width.
  - Cast a (θ, φ) grid of rays from C: 180–360 azimuths × about 250 elevations, from 75° up to 50° below horizontal.
  - Each ray's first hit (`RayCaster.first`, which hits back faces) gives a star-shaped "unwrapped image" of the crown
    and the surrounding gum. The cervical wall is seen from inside, so undercuts are sampled densely.
  - Per cell, score:
    - concavity of the column's 3D profile (turning angle after arc-length resampling, at two scales: ±0.15 and
      ±0.4 mm);
    - plus an optional colour-gradient term;
    - plus a weak height prior.
  - Solve the closed boundary φ*(θ) with a circular DP (|Δφ| ≤ 3 steps, transition cost proportional to the 3D step).
    Close the loop by fixing the first column to its top 5 states.
  - The output points are ray hits: on the surface, sub-vertex, closed by construction, no live-wire.
- **Why it should work:**
  - It turns a mesh problem into the classic polar-DP boundary problem used in IVUS and cell segmentation.
  - It is robust to noise (smoothness is global), independent of mesh resolution, and immune to grid stair-steps.
  - It sees undercuts.
  - Per-column cost margins give a **confidence per sector**, and the k-best paths give alternatives for the user.
- **Failure modes:**
  - C outside the tooth (an off-centre click on a narrow incisor). Fix: re-centre C on the first pass's centroid, and
    use the tooth's own axis for leaned teeth.
  - Rays through a fused contact jump to the neighbour. Detect a jump in hit distance and give those cells a neutral
    cost so the DP interpolates.
  - A deep fissure ring on molars at high φ (the height prior handles it).
  - Not star-shaped for strongly tipped molars.
- **Accuracy guess:**
  - Synthetic: mean 0.03–0.08 mm, max 0.15–0.3 mm.
  - Noise 0.05: mean 0.06–0.12 mm.
  - Softened crease: 0.1–0.2 mm.
  - Real: 0.1–0.25 mm.
- **Cost:**
  - 30k–90k rays: about 100–400 ms on a 1M-triangle demo jaw, about 50–150 ms on a real scan.
  - The DP is under 10 ms. $0.
- **Time to ship:** 2–4 days.
- **Experiment (45 min):**
  - New file `starUnwrap.ts` with: C from `estimateToothFrame`'s origin and occlusal, `templateForTooth(fdi).size`,
    and `ray.first`; the grid; the unary; the DP; the back-map. Then `smoothOnSurface`.
  - Score on the full matrix, including lean 25° and noise 0.05.
  - Ablate one scale versus two, and with and without colour.
  - Log per-sector confidence against per-sector error, to see whether low confidence predicts error.

### P3. Crease-weighted harmonic field (random walker): tooth seeds versus gum seeds
- **Idea:**
  - On the local patch (vertices within 1.6× the crown radius + 2 mm), solve Laplace's equation.
  - Edge conductance `w = exp(−β·max(0, −κ̄)/κ_ref) · exp(−γ‖ΔLab‖²)`.
  - Dirichlet seeds:
    - u = 1 on the crown top (the upper 35% of the height drop, within 0.4× the radius of the axis);
    - u = 0 on the patch's outer ring and on the neighbours' crown tops (at ±MD along `frame.mesial`).
  - Take the u = 0.5 isoline by marching through triangles (sub-vertex, smooth, closed). Keep the loop around the
    origin.
  - This is Zou et al. 2015's tooth-target harmonic field and Grady's random walker. Leaving out the seeds gives the
    normalized-cut variant (the Fiedler vector).
- **Why it should work:**
  - Low conductance concentrates the potential drop on the crease.
  - Diffusion averages noise.
  - Neighbour seeds split fused contacts.
  - Scribbles are just more seeds, so the same solver is the human-in-the-loop tool (P15).
- **Failure modes:**
  - Where the crease is weak (soft crease, the col), the 0.5 level drifts with the seed geometry. Fix: per-sector
    isovalue or P10 snapping.
  - Seeds that fall on the wrong tooth.
  - CG convergence on 200k vertices.
- **Accuracy guess:**
  - Synthetic: mean 0.05–0.12 mm, max 0.2–0.4 mm.
  - Real with colour: 0.1–0.25 mm.
- **Cost:** CG with a Jacobi preconditioner takes about 150–400 ms at 150k vertices and 20–60 ms at 25k. $0.
- **Time to ship:** 3–5 days.
- **Experiment (45 min):**
  - Domain mask, seeds (heights along `frame.occlusal`), conductances from `analyzeSurface().curvature` and the
    vertex colours.
  - A CG solver over the CSR `SurfaceGraph` (`buildVertexAdjacency`).
  - The isoline chain.
  - Sweep β ∈ {2, 4, 8}.
  - Compare against the threshold-region variant (faces with u > 0.5 → `boundaryLoops` from `meshValidate.ts`) to show
    the isoline is worth it.

### P4. Competing-front watershed on a crease relief
- **Idea:**
  - Marker-based watershed (Meyer priority flood) on the mesh graph, with relief = concavity strength (smoothed
    `−κ⁺`, optionally plus the colour gradient).
  - A tooth marker and gum markers (as in P3) flood in order of relief, using `MinHeap` from `livewire.ts`.
  - The labels meet on the relief's ridge, which is the crease.
  - Then extract the boundary loop, polish with `smoothOnSurface`, or run P10.
- **Why it should work:** it is the cheapest region method there is (one O(n log n) pass), it needs no parameters
  beyond the relief, and it gives a hard partition.
- **Failure modes:**
  - Leaks through one weak spot in the crease (watershed has no global smoothness).
  - The boundary follows mesh edges (stair-steps until refined).
  - Very sensitive to noise without relief smoothing.
- **Accuracy guess:** synthetic 0.05–0.15 mm; noisy or real 0.15–0.5 mm, with occasional leaks over 1 mm.
- **Cost:** 20–80 ms. $0.
- **Time to ship:** 1–2 days.
- **Experiment (30 min):**
  - Reuse P3's seeds and domain: about 50 lines with `MinHeap`.
  - Build the relief from `smoothScalar(curvature, graph, k)`, k ∈ {0, 2, 5}.
  - Report leak rate (max deviation over 1 mm) under noise. This is P3's cheap ablation and can run in the same
    harness.

### P5. Mesh GrabCut: self-calibrating unaries plus a concavity graph cut
- **Idea:**
  - A binary MRF on vertices.
  - Unaries from per-scan 3-component GMMs per class, over: Lab colour, normalized height above C, n·occlusal, radial
    distance over the expected radius, curvature at 3 scales.
  - Initialise from P3's seeds. Pairwise Potts term `λ·exp(−β·concavity⁺)`, so cutting along concave edges is cheap.
  - Solve with Boykov–Kolmogorov max-flow. Re-estimate the GMMs from the cut and repeat 3–5 times (GrabCut).
  - Take the boundary, then P10.
- **Why it should work:**
  - The best way to fuse colour and geometry.
  - It self-calibrates per scan, so scanner colour differences don't matter.
  - Cutting along edges is cheap exactly where we want the boundary.
- **Failure modes:**
  - Metrication stair-steps (needs P10).
  - The GMMs collapse when there is no colour and the geometry features overlap.
  - The repo has no max-flow implementation (about 150 lines to write).
- **Accuracy guess:** synthetic 0.05–0.15 mm (refined 0.03–0.08 mm); real with colour 0.08–0.2 mm.
- **Cost:** 100–400 ms at 150k vertices, 30–80 ms at 25k. $0.
- **Time to ship:** 4–6 days.
- **Experiment (45 min):**
  - Features from `analyzeSurface` (curvature at several `smoothScalar` levels), `smoothVertexNormals`,
    `distanceFromMargin` (`intaglio.ts`) for geodesic distance from the origin vertex, and the colours.
  - BK max-flow. If time runs out, swap in P3's solver with unary priors (Grady 2005).
  - Compare colour on and off.

### P6. Colour likelihood: gingiva versus enamel in Lab
- **Idea:**
  - Convert vertex RGB to CIELAB.
  - Fit two Gaussians per scan: one from crown-top colours near the click, one from gum colours on the patch's outer,
    lower ring.
  - Per-vertex log-likelihood ratio, smoothed with `smoothScalar` ×2.
  - Flood the region with LLR > 0 from the origin, close it (`closeRegion`), take the boundary (`boundaryLoops`), and
    **snap to the nearest concave crease within 0.5 mm** (P10).
  - Main use: a cue fed into P2, P3 and P5. It can also run alone.
- **Why it should work:**
  - On real coloured scans, gum and enamel separate cleanly in a* (the gum's redness).
  - It is independent of the geometry, so its errors are uncorrelated with the crease detectors'. That makes it ideal
    for consensus (P14).
- **Failure modes:**
  - No colour (STL).
  - The colour boundary is offset from the geometric one (texture misregistration, 0.1–0.3 mm).
  - Blood, inflamed gum, shadowed embrasures, specular highlights, composite or metal restorations.
  - The synthetic ramp biases the 50% isoline about 0.5 mm up the wall.
- **Accuracy guess:**
  - Synthetic: LLR = 0 isoline 0.3–0.5 mm (the ramp bias); with the crease snap 0.05–0.1 mm.
  - Real: 0.1–0.3 mm.
- **Cost:** under 20 ms. $0.
- **Time to ship:** 1–2 days.
- **Experiment (30 min):**
  - Lab conversion, the GMM (3×3 covariance; `symmetricEigen3` from `pca.ts` for the inverse), flood over the graph.
  - Export `closeRegion` and `facePatch` from `wingOutline.ts`.
  - Report the bias with and without the snap, and at thresholds 0.1 and 0.5. This quantifies the ramp artefact before
    anyone trusts colour numbers.

### P7. Height-field top-hat: subtract the gum, then segment in 2D
- **Idea:**
  - Rasterize a 24 × 24 mm occlusal height map at 0.05 mm (a CPU z-buffer of the local triangles, about 20 ms; or
    `ray.first` per pixel).
  - Morphological opening with a disc of about 0.6× the crown's bucco-lingual half-width removes the protruding crown
    and keeps the gum. The residual above 0.15 mm is the tooth mask.
  - Optionally fit the gum membrane instead: harmonic interpolation or `solveRbf` from the gum ring.
  - The mask edge seeds a 2D polar DP on the residual's gradient. Back-project with top-down rays, then P10 on the
    mesh.
- **Why it should work:**
  - The synthetic is literally `gum + max(0, tooth)`.
  - 2D morphology is fast and well understood.
  - It gives a "height above gum" feature for P5 and P11.
- **Failure modes:**
  - Undercuts (top-down).
  - Papillae are narrow and get partly opened away, so the line drops interproximally on real anteriors.
  - Steep walls: a small xy error is a large z error.
  - **Benchmark-flattering:** the critic should discount its synthetic score.
- **Accuracy guess:** synthetic 0.05–0.15 mm; real 0.3–1.0 mm interproximally, 0.15–0.3 mm buccal and lingual.
- **Cost:** 30–60 ms. $0.
- **Time to ship:** 2–3 days.
- **Experiment (30–45 min):**
  - Height map, opening (separable erosion and dilation, van Herk), mask, polar DP (P2's DP code over (θ, r) in 2D),
    back-projection.
  - Compare upright versus leaned 25° to measure the undercut penalty directly.

### P8. Multi-view renders plus click-prompted SAM, back-projected to the mesh
- **Idea:**
  - Render the tooth orthographically from 5–8 views in the tooth frame (`crownAxes`): occlusal, plus buccal, lingual,
    mesial and distal at 45°.
  - Render colour when present, otherwise normal or matcap shading with crease darkening (curvature as shade), at
    512² with 0.04 mm per pixel.
  - Render a triangle-ID buffer alongside, for back-projection.
  - Prompts: positive = the projected click plus 2 points at 0.3× the radius; negative = gum-ring points and the
    neighbours' tops.
  - Run a SAM-family model in the browser: MobileSAM, EfficientSAM or SlimSAM, all Apache-2.0, through ONNX Runtime
    Web on WebGPU.
  - Vote per vertex, weighted by n·view. Take the 0.5 isoline, then P10.
- **Why it should work:**
  - Zero training.
  - SAM is very good at "this object at this click", and in real colour renders the tooth is an obvious object.
  - Several views cover the undercuts.
- **Failure modes:**
  - The masks pick the wrong granularity (one cusp, or the whole arch).
  - Renders without colour are less distinct.
  - Mask edges are soft over 2–4 px (0.1–0.15 mm).
  - Model download of 10–40 MB; slow fallback without WebGPU.
  - Synthetic renders look unlike real teeth, so the benchmark under-predicts or over-predicts.
- **Accuracy guess:** 0.15–0.4 mm before the snap, 0.08–0.2 mm after.
- **Cost:**
  - 0.5–3 s per tooth on WebGPU, 3–10 s on WASM, a one-time download.
  - Or 0.2–0.5 s on a server GPU (the OCI VM has none).
  - $0 marginal.
- **Time to ship:** 1.5–3 weeks.
- **Experiment (45 min, risky):**
  - A CPU rasterizer for colour and IDs (about 80 lines), onnxruntime-node, and an Apache-2.0 SAM ONNX export.
  - Needs network access for the weights. If there is none, test the render and back-project plumbing with P7's 2D
    segmenter and stop.
  - Report per-view IoU against the projected labels, and the fused 3D deviation.

### P9. Library tooth fit, then transfer its cervical loop and snap
- **Idea:**
  - Fit `templateForTooth(fdi)` to the natural crown with `fitAnatomy` (`anatomyFit.ts`): ICP over position, rotation
    and per-axis scale, with cervical-rim correspondences already dropped.
  - Inputs: collar points = scan vertices above (gum level + 30% of the crown height) within the expected radius,
    with `smoothVertexNormals`; frame = `estimateToothFrame`; `margin` = P1's line, or an ellipse of the template's
    md × bl at the gum level.
  - Map `template.cervicalLoop` through the fitted shell. That gives a shape-correct prior line.
  - Snap it to the crease within ±1–1.5 mm with P10.
- **Why it should work:**
  - A strong shape prior bridges the parts the scan cannot see (interproximal, fused contacts) and the weak creases.
  - The machinery already exists for inlays and onlays.
- **Failure modes:**
  - The synthetic templates (`syntheticTemplate`, footprint exponent 3) differ from the arch teeth (exponent 4) and
    from real cervical scallops.
  - The template's cervical loop is planar (z = 0), while real lines scallop 1–4 mm.
  - Worn, rotated or tipped teeth.
  - ICP drifts onto neighbours.
- **Accuracy guess:** prior 0.4–1.0 mm; after the snap 0.08–0.2 mm, best on the interproximal sectors.
- **Cost:** 50–200 ms (ICP plus RBF). $0.
- **Time to ship:** 2–4 days. Real value comes when real library teeth arrive (`tools/library-builder`).
- **Experiment (45 min):** fit, transfer the loop, P10. Report prior deviation and snapped deviation per sector
  (mesial, buccal, distal, lingual) to show where the prior helps.

### P10. Profile snake: sub-vertex crease refinement by two-segment regression *(shared stage)*
- **Idea:**
  - Given any coarse closed line, place stations every 0.25 mm.
  - At each station, take the surface normal n and the across direction a = tangent × n, signed outward from the axis.
  - Sample a ±1 mm cross-section by casting along −n from `station + s·a + L·n`, s in steps of 0.02 mm.
  - Fit a **continuous two-segment piecewise-linear model** (breakpoint search, closed-form least squares). The
    breakpoint s* is the crease. The angle change and the reduction in residual give its strength.
  - Keep the top 3 breakpoints per station. Choose one per station with a 1D circular DP: the same cost shape as
    `ringDpAnchors`, mapping offset → `radiusMm`, height → `dropMm`, strength → `convexity`.
  - Move the points, project with `ray.closestPoint`, `smoothOnSurface`. Iterate twice.
  - A drag in the UI snaps to the same breakpoint ("magnetic").
- **Why it should work:**
  - Regression over many samples is far more robust to noise than 1-ring curvature.
  - It finds the virtual sharp corner of a softened crease, which is the most defensible definition.
  - It removes stair-steps (the 146–157° kinks), is resolution-independent, and lifts every coarse method in this
    list.
- **Failure modes:**
  - Locks onto a nearby fissure or embrasure when the coarse line is more than 1 mm off.
  - The cross-section is ill-posed where the line turns sharply (the papilla tip).
  - With a fillet, check how the benchmark labels the boundary before choosing between the corner and the fillet
    midpoint.
- **Accuracy guess:** on clear creases, 0.02–0.06 mm from a 0.3 mm start; on softened creases 0.05–0.12 mm.
- **Cost:** 10–40k rays, about 30–100 ms. $0.
- **Time to ship:** 2–3 days.
- **Experiment (30–45 min):**
  - Implement it and apply it to the outputs of P1 and of P3, P6 or P9 where they exist.
  - Report the deviation before and after, and the sharpest turn before and after.
  - Add a synthetic perturbation test: the truth plus 0.3 mm and plus 0.8 mm sinusoidal offsets, to find its capture
    range.

### P11. Per-vertex feature classifier trained on synthetic labels (stepping stone to learning)
- **Idea:**
  - Hand-crafted features per vertex: curvature at 3 smoothing scales, shape index from the 1-ring quadric
    (`symmetricEigen3`), n·occlusal, normalized height above C, radial distance over the expected radius, geodesic
    distance from the origin (`distanceFromMargin`), local roughness (normal minus smoothed normal), Lab (with
    dropout).
  - Train a logistic regression or a 2-layer MLP in TS on some teeth and variants. Test on held-out teeth and jaws.
  - Turn the probabilities into a line with P3's solver (probability as unary) or as an isoline, then P10.
- **Why it should work:**
  - It learns how to weight the cues, instead of guessing β, γ and λ.
  - The feature, label and evaluation pipeline carries over unchanged to Teeth3DS or in-house labels.
- **Failure modes:**
  - Overfits the synthetic (the clean crease and the colour ramp). Hold out whole tooth types and noise levels, and
    expect a gap on real scans.
  - Feature scales differ across scan resolutions (normalize by mean edge length).
- **Accuracy guess:** synthetic held-out 0.05–0.15 mm; real unknown.
- **Cost:** under 50 ms inference. Training in seconds. $0.
- **Time to ship:** 1 week, plus data.
- **Experiment (45 min):** train on 36, 46 and 14 (clean and noise 0.02); test on 11 (leaned), 13, 45 and upper 26
  (noise 0.05). Compare against hand-weighted P3 at the same isoline step.

### P12. Learned 3D tooth segmentation (MeshSegNet, TSGCNet or ToothGroupNetwork class)
- **Idea:**
  - A point or mesh network on a tooth-centred crop (8k–16k points in the tooth frame), binary "this tooth" versus
    "not this tooth". Or full FDI labelling of the arch.
  - Interpolate to vertices, take the isoline, then P10.
  - Train on Teeth3DS+: 1,800 scans with per-vertex FDI and gum labels (3DTeethSeg'22). As far as I recall it is
    **CC BY-NC-ND 4.0, i.e. non-commercial**, so it is fine for benchmarking and research but not for training a
    shipped model. Verify this.
  - Shipping needs in-house labels. Get them by pre-labelling with P2 or P3 and having technicians correct them (the
    plan's `ProposalEvent` flywheel). Check every public checkpoint's licence.
- **Why it should work:**
  - Published networks reach roughly 95–98% segmentation accuracy on Teeth3DS.
  - They learn papillae, fused contacts and recession from data.
- **Failure modes:**
  - The boundary band is these networks' weakest part (hence their graph-cut post-processing).
  - The domain gap from scanner to scanner.
  - Licences.
  - Model size and latency in the browser.
- **Accuracy guess:** real 0.1–0.3 mm at the boundary before P10. Not meaningful on the synthetic.
- **Cost:**
  - ONNX Runtime Web: 2–10 MB, 0.1–0.5 s on WebGPU, 1–3 s on WASM. Or about 0.5–1 s on the OCI VM's ARM CPU.
  - Training: a few GPU-hours, $5–50.
- **Time to ship:** 4–8 weeks, gated on data and licences.
- **Experiment (45 min):** only if the scout fetched Teeth3DS and an openly licensed checkpoint. Run it on 10 scans,
  measure gingival-boundary deviation per tooth against the labels, and time it on CPU. Otherwise defer, and run
  P2, P3 and P6 on those Teeth3DS scans instead (no colour there).

### P13. Arch-level joint segmentation with neighbour and FDI-order priors
- **Idea:**
  - Segment the target tooth together with its neighbours.
  - Crown-top seeds come from the crest peaks along `fitArchCurve` (re-implement or export `findPreps`' crest and peak
    step). Assign FDI order with `archOrdinal`, the midline and case setup.
  - A K-label random walker: P3's matrix with K right-hand sides, label = argmax.
  - Each tooth's line is where its potential stops winning. Against the gum that is the crease; against a neighbour it
    is the interproximal valley.
  - Compute once per jaw and cache it, as `prepFinder` is. That also yields tooth segmentation for free.
- **Why it should work:**
  - Teeth compete for the contact zone, which fixes fused contacts and "which tooth owns the col".
  - Neighbour lines must meet at the papilla.
- **Failure modes:**
  - A missing or extra peak (a diastema, a missing tooth) mislabels the arch.
  - Heavy on a 1M-vertex demo jaw (needs a coarse level or windows).
  - The synthetic has no real contacts, so its benefit cannot be shown there.
- **Accuracy guess:** like P3 buccally and lingually; better interproximally on real scans (0.1–0.3 mm versus
  0.3–0.8 mm).
- **Cost:** a 3-tooth window takes 0.3–1 s at demo scale and 0.1–0.3 s on real scans. $0.
- **Time to ship:** 1–2 weeks.
- **Experiment (45 min):** a 3-tooth window (target plus mesial and distal neighbours plus gum, 4 labels) on P3's
  solver. Compare the mesial and distal sector errors with P3's 2-label result, on clean and on noise 0.05.

### P14. Consensus line: multi-source ring DP with per-sector confidence
- **Idea:**
  - Intersect each method's line (P2, P3, P6, P10 outputs) with N radial half-planes around the frame axis. Each method
    contributes per-sector candidates, weighted by its own local confidence.
  - Run `ringDpAnchors` over the union, with a small "agreement" bonus. Close and refine with P10.
  - Per-sector confidence = how much the sources agree (their spread) plus the crease strength.
  - That confidence drives the QA gate ("sector X uncertain") and the UI heat map.
- **Why it should work:** the cues fail in uncorrelated ways (colour versus geometry versus prior), and `ringDpAnchors`
  already does exactly this selection for one source.
- **Failure modes:** methods that agree on the same wrong valley (the fissure ring); the extra latency of running 2–3
  methods.
- **Accuracy guess:** no worse than the best single method, with fewer failures over 0.5 mm. Calibrated confidence is
  the main gain.
- **Cost:** the sum of its members (100–500 ms). $0.
- **Time to ship:** 1–2 days once two members exist.
- **Experiment (30 min):** after two or more proposals land. Report the error distribution against the best single
  method, and the AUROC of per-sector confidence for predicting sector error over 0.2 mm.

### P15. Human-in-the-loop kit: confirm or fix the line in seconds
- **Idea:** five tools in the Margin step.
  1. Colour the line by per-sector confidence (from P2, P10 or P14).
  2. "Alternatives" chips on low-confidence sectors: P2's k-best paths per sector. Tap to swap.
  3. Scribble on the tooth or the gum: the strokes become P3 seeds, re-solved with a warm start in under 200 ms.
  4. A cross-section inset at the cursor showing P10's profile with a draggable breakpoint.
  5. Magnetic drag: snap to the nearest concave breakpoint within 0.5 mm.

  These sit beside the existing margin tools (`marginTools.ts`: `addAnchor`, `moveAnchor`, `smoothWork`).
- **Why it should work:**
  - Technicians accept a line after a glance when the doubtful places are pointed out.
  - Fixing them takes one tap or stroke instead of re-tracing.
- **Failure modes:** UI cost; confidence that is miscalibrated (P14 measures it); scribbles on noisy scans that need
  more seeds.
- **Accuracy:** human-level. The metric is edits and seconds to an acceptable line.
- **Cost:** front end only. $0.
- **Time to ship:** 3–7 days.
- **Experiment (45 min): oracle editing on the benchmark.**
  - Start from P2's or P3's line.
  - Loop: find the sector with the largest deviation over 0.15 mm; add a seed pair (P3) or an anchor (`addAnchor`) at
    the true point; re-solve.
  - Count the edits until mean < 0.08 mm and max < 0.2 mm.
  - Report edits per case. A median of 0 to 2 is shippable.

---

## 4. Spillover to prepared teeth

- **The gum line as a barrier.**
  - Restrict `proposeMarginAnchors` candidates to the occlusal side of the gum line (P2's φ*(θ) or P3's u > 0.5
    region).
  - The false edges in `margin-eval`'s noise 0.04–0.07 cases lie mostly in the gum.
  - Measure it with the existing `MARGIN_CASES` and `refineMethod`, before and after. It is a cheap and immediate win.
- **Subgingival detection.** In a sector where no convex finish line lies above the gum line, report "margin hidden by
  the gum here" instead of tracing a kinked line, and offer the gum line as the provisional margin with a warning.
- **Colour veto.** A convex edge on gum-coloured surface is not a finish line.
- **The pre-op scan as a prior.** A natural line computed on the pre-op scan (`syntheticPreop` exists) gives the search
  band on the prep scan after registration.
- **A gate of its own for natural lines.** The prep gate's thresholds (`MARGIN_MAX_TURN_DEG` 120°, wander 1.15) were
  tuned on preps, and a real papilla can legitimately turn sharply. Add per-FDI length ranges and a per-sector crease
  strength, both measured on Teeth3DS when it is available.

## 5. Ranking

| Rank | Proposal | Why |
|---|---|---|
| 1 | **P2 star unwrap + circular DP** | Sees undercuts, closed by construction, sub-vertex, no stair-steps; one DP is global smoothness; gives per-sector confidence and k-best alternatives for free; about 100–300 ms; 2–4 days; needs only `RayCaster`. |
| 2 | **P3 crease-weighted harmonic field** | The most robust region method (diffusion averages noise); neighbour seeds handle fused contacts on real scans; colour enters as conductance; the same solver powers scribble editing (P15) and the arch version (P13). |
| 3 | **P10 two-segment profile snake** | A small shared stage that lifts every coarse method to under 0.06 mm on clear creases, fixes softened creases and the 150° kinks, and is the magnetic snap for editing. Measure it on top of P1 and P3. |
| 4 | **P6 colour likelihood** | About 20 ms and 1–2 days; on real coloured scans it is the strongest single cue, and independent of geometry. Ship it as a term inside P2 and P3, and run it alone only to quantify the ramp bias. |
| 5 | **P1 valley ring DP** | The fastest to ship (1–2 days, almost all reuse) and the baseline the others must beat. It also gives the "gum line as a barrier" win for preps immediately. Expect it to look good on the upright synthetic cases and lose on leaned ones. |

**Suggested parallel benchmark runs:** P1 (baseline), P2, P3 (+ the P4 ablation), and P10 applied to all of them. Run
colour on and off, and include lean 25° and noise 0.05 in every run.

**Not in the top 5, and why:**
- P5 adds a max-flow implementation for little over P3 with colour.
- P7 is benchmark-flattering.
- P8, P12 and P13 have the best real-scan upside but weeks of time to ship, or need data the synthetic can't
  validate.
- P9 is valuable mainly once real library teeth exist.
- P14 and P15 come after two or more methods land.

**Moonshot: fit two surfaces and intersect them.**
- Fit an anatomical tooth model (a statistical shape model or an implicit SDF from the library) and a gum model (a
  smooth membrane with papilla bumps between the FDI-ordered neighbours) jointly to the scan by analysis-by-synthesis:
  minimise the scan-to-model distance, with each scan point assigned to its nearer model.
- The margin is then the analytic **intersection curve** of the two fitted surfaces. It is sub-vertex, defined even
  where the scanner saw nothing (under contacts), and gives the CEJ-like tooth extension below the gum for free
  (useful for a virtual prep).
- Train the shape priors on a procedural "synthetic factory": this generator extended with papillae, recession,
  contacts, colour blur and scanner noise. Fine-tune them on technician-corrected lines from the flywheel.
- Risk: weeks of work, and the fit is non-convex (it needs P2 or P3 to initialise). Reward: one model for margin,
  segmentation, virtual prep and eggshell design.

**Parked:** a one-shot vision check. Render the line on the tooth and ask "which sectors are off?": one call,
$0.01–0.03, 3–8 s. It would only be QA, never geometry. Given the margin-ai result (no accuracy gain, at minutes and
dollars), it is not worth building before P14's computed confidence exists.

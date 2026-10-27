# Scout: finding the gingival margin on natural teeth (prior art, data, competitor UX)

2026-10-27. This is a 25-minute scan, not a systematic review. Confidence is marked where it matters.
"Verified" means I read the primary source: the repo, the OSF API, the paper abstract, or the vendor doc page.
"Snippet" means the claim comes from a search-engine summary of that page, because the page itself blocked my
fetcher.

Real data is now on disk: 6 Teeth3DS+ jaws (3 upper, 3 lower, all in the training split) are in
`data/teeth3ds/`, ~100 MB. The loader note is `data/teeth3ds/LOADER.md`.

---

## 1. Methods: tooth/gingiva boundary and tooth segmentation on IOS meshes

### Classical / training-free

- **Zou et al. 2015, tooth-target harmonic field (interactive).** The user places a few seeds on the tooth and the
  gum. A Laplace (harmonic) field is solved with those seeds as Dirichlet constraints, and the boundary is an
  isoline of the field. The authors say it is robust to crowding and noise and always gives a *closed* boundary.
  Curvature-only methods need morphological clean-up to get that. No boundary accuracy in mm was found. One sparse
  solve per click, so it is cheap: milliseconds on a cropped patch of 20–50k vertices. No public code found.
  Comput Biol Med 56:132–144. https://pubmed.ncbi.nlm.nih.gov/25464355 ·
  https://www.sciencedirect.com/science/article/abs/pii/S001048251400287X
- **Liao et al. 2015, automatic harmonic fields.** An automatic variant of the above with no seeds.
  https://onlinelibrary.wiley.com/doi/10.1155/2015/187173
- **Interactive segmentation field (PLoS ONE 2016).** Another seed-and-field interactive tooth separation method.
  https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0161159
- **Kronfeld et al. 2010, snakes.** Computes an initial tooth/gum separating curve from the dental arch and the
  interstices, then refines it with an active contour placed around each crown. It needs minimal interaction.
  No numbers verified. CAD&A 7(2). https://www.researchgate.net/publication/228578694
- **Random walker.** The TeethSeg team in 3DTeethSeg'22 used a coarse 3D U-Net followed by random-walker
  refinement on local geometry and convexity, and scored TSA 0.9678. That is evidence that random-walk or graph
  refinement of a coarse mask gives good boundaries. https://arxiv.org/html/2305.18277
- **Graph cut.** MeshSegNet uses a multi-label graph cut as post-processing. The dental-mesh-workbench (next item)
  makes graph cut the whole method.
- **dental-mesh-workbench (carlmarco), the closest prior art to what we need.** Verified README.
  - Method: training-free tooth/gingiva labelling. Concavity-weighted heat-geodesic seeds, then a graph cut with
    "crease-aware" (κ_min) boundary costs, then a per-tooth multi-label cut.
  - Accuracy on 299 held-out Teeth3DS test scans: boundary **ASSD 0.285 mm (median 0.219)**, HD95 1.98 mm,
    boundary F1 0.906 at 0.5 mm, tooth IoU 0.936. Per-vertex gingiva IoU is 0.911, against ~0.96 for supervised
    networks.
  - Progression: a plane-cut baseline scored 1.66 mm, the geodesic Voronoi 0.551 mm, the binary graph cut
    0.338 mm, and the per-tooth cut 0.285 mm.
  - Speed: 0.65–1.1 s per scan native, "several seconds" in the browser.
  - Packaging: C++20 compiled to WASM (267 kB) with a Three.js viewer. **MIT.**
  - Caveats: one author, about two weeks old (created 2026-10-09), 0 stars, and the numbers are self-reported.
    The author notes that this margin is the tooth/gingiva boundary, not a prep finish line, which is exactly our
    case. https://github.com/carlmarco/dental-mesh-workbench
- **Curvature thresholding alone.** Zou and others report it is unreliable: it leaves open contours and fires on
  fissures. See the measured cue in §5.

### Learned (2019–2026)

| Method | What | Boundary / accuracy | Compute | Code, weights, licence |
|---|---|---|---|---|
| **MeshSegNet** (Lian et al., TMI 2020) | Graph-constrained multi-scale mesh net plus graph cut; 15 classes (14 teeth and gingiva) | Paper DSC not verified here | Downsamples to ≤10k cells (the repo warns of GPU OOM above that). Dense N×N adjacency inputs make the browser costly | **MIT** code. Upper and lower weights in `./models`, trained on private UNC data. https://github.com/Tai-Hsien/MeshSegNet |
| **iMeshSegNet / TS-MDL** (Wu et al. 2021) | Two-stage, lighter MeshSegNet plus landmarks | not verified | lighter | Apache-2.0 re-implementation: https://github.com/ziyangyeh/iMeshSegNet-Reg · paper https://arxiv.org/pdf/2109.11941 |
| **TSegNet** (Cui et al., MedIA 2021) | Centroid detection, then per-tooth patch segmentation | not verified | GPU | No official code found. Re-implemented inside ToothGroupNetwork. https://www.sciencedirect.com/science/article/abs/pii/S1361841520303133 |
| **ToothGroupNetwork** (CGIP, **winner 3DTeethSeg'22**) | Point Transformer, grouping, then tooth cropping for tooth/gingiva refinement | Final 0.9539, **TSA 0.9859**, TLA 0.9658, TIR 0.9100 | ≥11 GB GPU, CUDA pointops; not browser-portable | **No licence file**, so all rights reserved by default. Checkpoints on Google Drive. https://github.com/limhoyeon/ToothGroupNetwork |
| **FiboSeg** (2nd place, UNC/UMich) | Renders the mesh into 2D views (normals as RGB plus depth) at 320 px, runs a Residual U-Net, majority-votes back to vertices | Final 0.9480, TSA 0.9293, TLA 0.9924 | **2D U-Net on rendered views: the most browser-friendly design** (three.js renders plus ONNX Runtime Web/WebGPU). The current Slicer extension needs Linux and CUDA | Slicer extension **Apache-2.0**. Weights `07-21-22_val-loss0.169.pth` (**6.6 MB**) in GitHub release v3.0, "trained using the data available for the 3DTeethSeg challenge", which is CC BY-NC-ND, so the weights' commercial status is unclear. https://github.com/DCBIA-OrthoLab/SlicerDentalModelSeg |
| IGIP (3rd) | Gingiva separation, PointNet++ centroids, patches | TSA 0.9750 | GPU | via challenge repo |
| **CrossTooth** (CVPR 2025) | Curvature-aware selective downsampling that keeps vertices at the tooth/gingiva band, plus multi-view rendered-image boundary features | tooth mIoU 95.86 %, **boundary IoU 82.06 %** (+5.7 over TGNet) | Point Transformer v1, CUDA pointops | Code plus PTv1 weights. **No licence file.** https://github.com/XiShuFan/CrossTooth_CVPR2025 · https://arxiv.org/abs/2503.23702 |
| **3DTeethSAM** (AAAI 2026) | SAM2 on rendered views plus adapters, voted back to 3D | IoU 91.90 % on 3DTeethSeg | heavy (SAM2) | Code status not verified. https://arxiv.org/abs/2512.11557 |
| **Radboud ToothInstanceNet / 3dteethland** | Stratified Transformer; trained on full and *partial* arches | Full-arch Dice 0.982; partial-arch Dice 0.986, macro-IoU 0.928; Teeth3DS F1 0.996 | GPU, CUDA ops | **MIT** code. Checkpoints on Google Drive. https://github.com/nnistelrooij/3dteethland · https://pmc.ncbi.nlm.nih.gov/articles/PMC12392768/ |
| Others, 2023–25 (not read) | TSegFormer (MICCAI'23), BATISNet and SOFTooth (Dec 2025, boundary-aware), GFACNet | – | – | https://arxiv.org/abs/2311.13234 · https://arxiv.org/abs/2512.24201 · https://arxiv.org/abs/2512.23411 |

- **3DTeethSeg'22 summary.** Six teams on 1,800 scans. The metrics are TLA, TSA (F1 per tooth) and TIR. None of
  them is a boundary distance in mm, so "segmentation accuracy" figures do not translate into margin accuracy.
  https://arxiv.org/abs/2305.18277 · https://github.com/abenhamadou/3DTeethSeg22_challenge
- **Partial scans.** Crown jobs are usually quadrant scans. Jana et al. (EMBC 2023) show that full-arch-trained
  networks under-perform on partial scans. https://arxiv.org/abs/2305.00244
- **Crown proposal from partial scans (May 2026).** DGCNN arch-type classifier, then registration and graph cut
  for the tooth/gingiva boundary. Macro DSC 0.925 and centroid error 0.27 mm, with a crown shell in 2.5–3.5 min.
  No code. https://arxiv.org/abs/2605.15241
- **Resolution study (2025).** PointMLP at 2k–16k cells; the numbers are not in the abstract.
  https://arxiv.org/abs/2502.19515

---

## 2. Margin-line detection on *prepared* teeth (for comparison; the finish line is a convex ridge, unlike the gingival crease)

- **Choi, Ahn, Park, J Prosthet Dent 2024.** 182 jaw scans, each with ≥1 natural-tooth abutment, split into
  desktop scans of trimmed casts and intraoral scans. The study compares Dentbird's hybrid deep-learning-plus-CAD
  method with 3Shape, exocad and Medit, scored by Hausdorff and Chamfer distance and technician acceptance.
  - Results: on trimmed-cast desktop scans all four were similar. On **IOS, Dentbird was significantly better**.
    Semi-automatic methods produced more outliers than automatic ones.
  - I could not get the mm values; the abstract is truncated at the p-value.
  - https://doi.org/10.1016/j.prosdent.2023.11.018 · https://pubmed.ncbi.nlm.nih.gov/38097424/
- **Alsheghri et al., Comput Biol Med 2025.** 1,113 prepared-tooth scans (1,035 train, 78 test). The network
  segments the prep into two regions so that the margin lies on the boundary between them. A 5-fold majority vote
  plus custom post-processing gives **70/78 within a 200 µm max distance and 62/78 within 100 µm**. The
  post-processing beat graph cut, DSC 0.986 vs 0.974. https://doi.org/10.1016/j.compbiomed.2025.110960
- **Alsheghri et al., Applied Sciences 2024 (AdaPoinTr point-cloud generation).** 913 train, 134 test. Median
  Chamfer **0.137 mm**, median Hausdorff **0.242 mm**. Also proposes a confidence metric for deployment.
  https://publications.polymtl.ca/59628/
- **Alsheghri et al., arXiv 2507.22859 (incisors).** 7/13 within 200 µm. Prep quality correlates with error
  (Spearman −0.683). They say they release train and test data; I did not find the link.
  https://arxiv.org/abs/2507.22859
- **Zhang et al. 2019, S-Octree CNN** for prep margins. Numbers not read. https://onlinelibrary.wiley.com/doi/10.1002/cnm.3241
- **Align patent WO2021046434A1.** Renders height-map images, has a CNN produce a margin probability map, then
  takes a minimum-cost contour. 2D colour images can be added. Low-confidence segments are highlighted or flagged
  for rescan. This is the same architecture as "render, 2D net, back-project". https://patents.google.com/patent/WO2021046434A1/en
- **Typical acceptance bar in this literature: ≤200 µm max deviation, ~100 µm for "good".**

---

## 3. Datasets

- **Teeth3DS+ / 3DTeethSeg'22.** Verified via the OSF API and the shipped `license.txt`.
  - Size: 1,800 IOS jaws from 900 patients, 23,999 teeth.
  - Scanners: Primescan, Trios 3 and iTero Element 2 Plus.
  - Format: **OBJ plus JSON**, `{id_patient, jaw, labels[nV], instances[nV]}`. Per-vertex **FDI** labels with
    0 = gingiva.
  - **No colour:** every vertex is constant grey 0.502, checked on all six downloaded jaws.
  - Annotation: 2D polygons drawn on a harmonic UV flattening, then back-projected, then clinically validated.
  - Access: **no login.** https://osf.io/xctdy/ has data_part_1…6 (labelled; part 1 is a 1.5 GB zip with
    150 upper and 150 lower jaws), data_part_7 (578 MB, 100 OBJ, *no labels*), and a 4 MB sample.
  - Split lists are on OSF.
  - **Licence: CC BY-NC-ND 4.0** per OSF `license.txt`, the GitHub README and Teeth3DS+ arXiv v2. Some secondary
    pages say CC BY or BY-SA; trust the file. Non-commercial, no distribution of derivatives. Commercial use goes
    through contact@udini.ai.
  - https://crns-smartvision.github.io/teeth3ds/ · https://arxiv.org/abs/2210.06094
- **3DTeethLand (MICCAI 2024).** 340 scans (240 train, 100 hidden test), same licence, at https://osf.io/um96h/.
  Landmark classes: Mesial, Distal, Cusp, **InnerPoint and OuterPoint**, FacialPoint. Inner and Outer are points
  on the tooth/gingiva boundary, lingual and buccal, one per tooth. That gives free sparse margin checkpoints.
  The winner scored mAP 0.785. https://arxiv.org/abs/2512.08323
- **ToothGroupNetwork's Google Drive mirror** of the challenge training split. The same data; the official route
  is OSF. https://drive.google.com/drive/folders/15oP0CZM_O_-Bir18VbSM8wRUEzoyLXby
- **Prepared-tooth margin datasets.** None found public. Alsheghri's group says one exists, but I could not locate
  it. The Radboud 600-IOS full/partial set is not public.
- **Colour plus labels.** I found **no public IOS dataset with scanner colour and per-vertex tooth/gum labels.**
  The colour cue would have to be validated on our own or partner scans.
- **Downloaded:** 6 jaws, ~100 MB on disk. Five came out of the 1.5 GB part-1 zip by HTTP range reads, about
  28 MB transferred. Details in `data/teeth3ds/LOADER.md`.

---

## 4. Competitor UX for marking and correcting margins

- **exocad DentalCAD.** Snippets from the exocad wiki; the wiki returned 403 to my fetcher.
  - *Seeding:* the wizard's margin step shows **a 2D cross-section "bubble" under the mouse pointer** while you
    hover, which helps you place the seed. For crowns, **one click** starts automatic detection. If it goes wrong,
    you click extra points on the true line to guide it.
  - *Editing:* **Correct/Draw** has three modes. *Edit* drags control points. *Magnetic* draws segments that snap
    to maximum curvature. *Free* clicks points. You delete a point by pressing left and right buttons on it, and a
    **brush** grows the margin area (Shift shrinks it).
  - *Hotkeys:* 1 Detect, 2 Edit, 3 Magnetic, 4 Free; **+/- moves the line up and down**; Ctrl+X clears;
    PageUp/PageDown orbit around the margin.
  - *3.2 Elefsina:* adds **Preparation Margin Repair**, which removes and redraws the line, smooths the scan, and
    can place a margin over a hole.
  - *Natural teeth:* the **Eggshell crown (Provisional)** job is designed "pre-operatively using scans of
    non-prepared teeth", with a pre-op model and an optional gingiva-mask scan. **I could not verify how the
    margin is set on the unprepared tooth in that flow.**
  - https://wiki.exocad.com/wiki/index.php/Detect_/_edit_margins · https://wiki.exocad.com/wiki/index.php/Hotkeys ·
    https://wiki.exocad.com/wiki/index.php/Defining_jobs_for_individual_teeth ·
    https://www.dental-tribune.com/c/exocad/news/joh-harich-app-specialist-at-exocad-on-the-new-tool-for-repairing-preparation-margins/
- **3Shape Dental System and Automate.** Snippets and press.
  - Margin detection is automatic for crowns, bridges and hybrid abutments.
  - 3Shape advises **toggling the scan colour on and off** while setting the margin, because each view shows
    different cues.
  - Design review has a Margin Line view (green good, red undercut) and a Cross Section view.
  - **Dental System 2025: AI "automatically detects and draws margin lines based on each tooth anatomy" in the
    copy-denture workflow.** Teeth there are natural or unprepared, so this is the closest shipped analogue.
  - **3Shape Automate**, a cloud service: AI designs in 90 s, 10 min or 10 h tiers, from $1.99, pay only for
    approved designs. It returns **snapshots of the margin line** for review. Labs can pre-mark margins in Dental
    System to steer it.
  - https://www.prnewswire.com/news-releases/3shape-boosts-dental-lab-speed-and-accuracy-with-ai-powered-workflows-302692618.html ·
    https://www.3shape.com/en/services/automate · https://support.fullcontour.com/hc/en-us/articles/13916426739099
- **Medit (ClinicCAD and scan software).** Snippets.
  - Margins are **created automatically on entering the step**. A global **Shrink/Expand slider** applies to all
    teeth or one tooth. Point editing: click to add, right-click to delete, drag to move.
  - At scan time, **Smart Scan Filtering (AI)** keeps only "Teeth + Gingiva", or with "Intense" only gingiva
    within a set distance of the teeth. **Smart Color Filtering** removes registered colours such as gloves.
  - Patent **US12711704B2** (Medit, 2021): an AI model "that uses **color information and curvature information**"
    distinguishes the target tooth and its neighbours from gingiva.
  - https://support.medit.com/hc/en-us/articles/24361689899929 · https://www.medit.com/new-iscan-function-smart-scan-filtering/ ·
    https://patents.google.com/patent/US12711704B2/en
- **Dentbird Crown (Imagoworks, browser CAD).** Verified from the doc page.
  - The AI detects the abutment, margin and tooth number on upload.
  - Preference **"Margin Line Extension"** is a global offset of −2 to +2 mm applied to the AI line before design.
  - Margin tool:
    - **Point mode:** drag, click empty space to add, right-click to delete.
    - **Pen mode:** freehand.
    - **Adjustment step plus Contract/Expand** moves the whole line.
    - **Redetect:** click a point and the AI re-detects from there.
    - **Clear**, **Show Undercuts**, and **Show Backface** (transparency).
  - Best of four on IOS in the JPD 2024 study above.
  - https://imagoworks.gitbook.io/dentbird-crown/refining-and-customization/margin-and-preparation.md
- **Carestream.** Snippets. CS Restore has Auto Margin Line for crowns only, or manual drawing. In CS ScanFlow the
  dentist marks margins at the chair and hands them to exocad. CS Model+ 3.0 has semi-automatic margin detection.
  https://www.manualslib.com/manual/1301544/Carestream-Cs-3500.html?page=48 ·
  https://orthodonticproductsonline.com/practice-products/software/treatment-planning/carestream-dental-unveils-cs-scanflow-updated-cs-model-latest-intraoral-scanner-cbct/
- **Blender for Dental (B4D).** Low confidence; vendor and SEO blogs only. Click points along the boundary and the
  tool connects them. https://www.blenderfordental.com/
- **TRIOS scanning.** "AI Scan" removes unwanted soft tissue, and colour scanning "clearly distinguishes teeth,
  gingiva and restorative materials". https://www.straumann.com/us/en/dental-professionals/digital-performance/equipment/io-scanners/3shape-trios.html
- **What makes these fast.**
  1. Detection starts on its own (on entering the step, or on one click).
  2. A cross-section under the cursor.
  3. One global offset (+/- or a slider) before any point editing.
  4. Re-detect from a clicked point instead of dragging many points.
  5. A snapping ("magnetic") draw mode.
  6. Colour on/off.
  7. A review snapshot.

  None publishes click counts. Typical vendor claims are "one click" for detection and "about a minute" per
  crown design.

---

## 5. Tricks that make this cheap and fast to ship

1. **The gingival margin is a concave crease, which is the opposite of a prep finish line.** I measured this on
   the 6 Teeth3DS jaws: **95–100 % of tooth vertices next to gingiva have negative smoothed mean curvature**
   (median −0.03 per edge length, against +0.01 on teeth and ≈0 on gum). dcad already has a ring DP over radial
   profiles (`marginRefine.ts`) and a curvature-cost live-wire (`livewire.ts`). Both currently make *convex*
   cheap and *concave* expensive, so flipping the sign for the natural-tooth job is most of an MVP. Fissures and
   embrasures are also concave. Restricting the search to a closed ring below the height of contour, around the
   tooth axis, handles that.
2. **A training-free graph cut is good enough.** The MIT workbench reaches 0.285 mm ASSD on Teeth3DS with three
   parameters, and runs in WASM. We can port its idea (geodesic seeds, then a crease-aware cut) to TS on a
   cropped single-tooth patch, which is small and fast. Or reuse its code under MIT.
3. **Use harmonic-field interaction for correction.** The tooth seed comes from the case setup and the gum is
   "far away". Each correction click adds a Dirichlet constraint, and the field is re-solved on the patch in
   milliseconds. The 0.5 isoline is always a closed loop. This is the cheap equivalent of Dentbird's "Redetect
   from point".
4. **Scanner colour, when present.** Gum is redder (higher a* in CIELab) than enamel. Use it as an extra data term
   in the cut or the DP; it is what Medit's patent does. dcad's PLY reader already parses vertex colours
   (`apps/web/src/geometry/ply.ts`). Teeth3DS has none, so this has to be validated on real exports. STL never has
   colour.
5. **Open weights for a browser model.** FiboSeg-style rendering plus a 2D U-Net is the ONNX/WebGPU-friendly
   route, and its 6.6 MB weights are public. But they were trained on NC-ND data, so treat them as research-only
   until legal says otherwise. All the point/transformer winners need CUDA ops.
6. **Free evaluation set.** Score with Teeth3DS per-vertex labels (ASSD and HD95 in mm, as the workbench does) and
   the 3DTeethLand Inner and Outer points. The licence allows local, non-commercial evaluation only: no fixtures
   in git, and nothing derived ships.

---

## Could not verify

- exocad wiki, Medit support and FullContour pages returned 403. Their UX details come from search snippets of
  those pages.
- How exocad and 3Shape set the margin on *unprepared* teeth (eggshell and copy-denture flows). I found only the
  claim that 3Shape 2025 does it with AI.
- The mm numbers in the JPD 2024 Dentbird comparison.
- The paper accuracies for MeshSegNet and TSegNet.
- Whether 3DTeethSAM's code is public.
- The workbench's numbers. They are self-reported, the repo is two weeks old, and I did not run it.
- The legal status of weights trained on CC BY-NC-ND data. This needs a lawyer, not a scout.

## Implications for dcad

- **Use a geometric method, not a learned one, for v1.** The cue is strong and measured (a concave crease at the
  tooth/gum junction, 95–100 % of boundary vertices), and an MIT training-free method already shows ~0.29 mm ASSD
  on Teeth3DS. Neither needs a GPU, weights or a licence.
- **Reuse dcad's margin machinery with the curvature sign flipped** for the natural-tooth job: the ring DP over
  radial profiles plus the live-wire. Today's "natural tooth is rejected" negative control becomes a separate
  "natural" mode, not a failure. Keep the rejection in prep mode.
- **The accuracy bar is ~0.2 mm max deviation.** Literature and labs use ≤200 µm, and Teeth3DS labels are only
  good to about one edge length (~0.2 mm). Report ASSD, HD95 and F1@0.5 mm in the pipeline runner so results
  compare with the workbench.
- **Teeth3DS is evaluation-only.** CC BY-NC-ND means no commercial training, no committed fixtures and no shipped
  derivatives. The 6 local jaws are enough for a development loop.
- **Correction UX to copy:** auto-detect on entering the step; a cross-section under the cursor; one global
  up/down offset (+/-); "click here to re-detect", re-solved from a constraint; and a snapping draw mode as the
  last resort before free point editing. Each of these is a single command in dcad's command/undo model.
- **Use colour where it exists, and never depend on it.** Add it as an optional data term when the PLY has vertex
  colour. STL and Teeth3DS have none, so the geometric path must stand alone.
- **Plan for quadrant scans.** Learned methods degrade on partial arches. A per-tooth local method (patch around
  the case-setup frame) is unaffected by scan extent.
- **If a learned model is wanted later,** the browser-viable shape is FiboSeg-style: render with three.js, run a
  2D U-Net in ONNX Runtime Web, back-project. It would have to be trained on licensed or own data, not Teeth3DS.

# Held-out score (lead, 2026-10-27)

24 cases: 6 Teeth3DS+ **test-split** jaws from 3 patients (none of the 6 development patients), teeth 11/13/14/16
upper and 31/33/34/36 lower. The experimenters never saw these jaws. Each method was run once, with the parameters
frozen at the end of its experiment. Scored at the labels' resolution (correct = mean ≤ 0.25 mm, p95 ≤ 0.6,
coverage ≥ 0.85; usable = mean ≤ 0.4, coverage ≥ 0.75). Times per tooth, median, Node on an M-series laptop.

| Method | Held-out correct | Usable | Median mean mm | ms | Dev-set real (23) | Synthetic (32) |
|---|---|---|---|---|---|---|
| Today's refiner (baseline) | 0/24 | 0/24 | 1.50 | 219 | 0/23 | 0/32 |
| S2 random walker (β 8, gum-side snap) `harmonic` | **22/24** | 23/24 | **0.07** | 52 | 21/23 (raw iso) | 16/32 |
| S2 random walker, raw isoline `harmonic-raw` | 22/24 | 22/24 | 0.10 | 47 | | |
| S2 random walker, re-centred `harmonic-rc-raw` | 22/24 | 22/24 | 0.11 | 80 | | |
| S2/P4 watershed, re-centred `watershed-rc` | 21/24 | 22/24 | 0.08 | 17 | 20/23 | 8/32 |
| S4 graph cut (our curvature, 16 mm patch) `s4-r16-ourcurv` | 19/24 | 21/24 | 0.08 | 264 | 17/23 | 8/32 |
| S4 graph cut (our curvature) `s4-ourcurv` | 17/24 | 20/24 | 0.10 | 195 | 15/23 | 8/32 |
| S4 graph cut, faithful port `s4` | 15/24 | 17/24 | 0.10 | 200 | 10/23 | 2/32 |
| S3 valley ring DP `valley` | 10/24 | 17/24 | 0.19 | 16 | 11/23 | 16/32 |
| S3 valley + profile snake `valley-snake` | 9/24 | 16/24 | 0.22 | 69 | 12/23 | 16/32 |
| S3 valley + concave-vertex snap `valley-snapv` | 9/24 | 17/24 | 0.20 | 69 | | |
| S1 star unwrap + circular DP, |Δφ| ≤ 3 cap `star-cap3` | 13/24 | 15/24 | 0.14 | 119 | 11/23 | 23/32 |
| S1 star unwrap + circular DP, frozen `star` | 7/24 | 14/24 | 0.29 | 315 | 7/23 | 24/32 |
| S3 prior-only control `prior` | 0/24 | 0/24 | 1.28 | 1 | 0/23 | 0/32 |

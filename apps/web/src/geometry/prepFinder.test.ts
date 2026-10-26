import { beforeAll, describe, expect, it } from 'vitest';
import type { V3 } from './pca';
import { findPreps, prepFor, type PrepFinding } from './prepFinder';
import { syntheticArch, syntheticPrepSeed, type ArchOptions } from './synthetic';
import { prepareMesh } from './testUtils';

// 0.3M triangles: on the 400 × 120 grid the premolar's 0.2 mm chamfer ledge is about one mesh row.
const ALONG = 600;
const find = (options: ArchOptions): PrepFinding => findPreps(prepareMesh(syntheticArch({ jaw: 'lower', along: ALONG, across: 250, ...options })));
const distance = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('prep finder', () => {
  let bridge: PrepFinding;
  let cavities: PrepFinding;
  beforeAll(() => {
    // The 35–[36]–37 bridge arch, and the same teeth with a MOD inlay cavity and an onlay instead of crown preps.
    bridge = find({ preps: [35, 37], missing: [36] });
    cavities = find({ preps: [], missing: [36], cavities: [{ fdi: 35, kind: 'mod' }, { fdi: 37, kind: 'onlay' }] });
  });

  it('finds the crown preps and pairs each tooth with its own, in arch order', () => {
    expect(bridge.preps).toHaveLength(2);
    for (const fdi of [35, 37]) expect(distance(prepFor(bridge, fdi, [35, 37])!.top, syntheticPrepSeed({ fdi, along: ALONG }))).toBeLessThan(1);
    // Counts that disagree on the tooth's side of the midline pair nothing, so a ring never shifts onto a neighbour.
    expect(prepFor(bridge, 35, [35])).toBeNull();
    expect(prepFor(bridge, 45, [45, 35, 37])).toBeNull();
  });

  it('rings no inlay or onlay cavity and no natural tooth', () => {
    expect(cavities.preps).toEqual([]);
  });
});

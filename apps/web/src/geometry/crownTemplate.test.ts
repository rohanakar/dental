import { describe, expect, it } from 'vitest';
import { closeCervix, syntheticTemplate, templateForTooth } from './crownTemplate';
import { computeBounds, boundsSize } from './mesh';
import { boundaryLoops, validateClosedMesh } from './meshValidate';

const KINDS = [
  ['molar', 'lower'],
  ['premolar', 'lower'],
  ['molar', 'upper'],
  ['premolar', 'upper'],
] as const;

describe.each(KINDS)('synthetic %s template (%s jaw)', (type, jaw) => {
  const t = syntheticTemplate(type, jaw);
  const P = t.mesh.positions;

  it('is open only at the cervix, consistently oriented and manifold', () => {
    const v = validateClosedMesh(t.mesh);
    expect(v.nonManifoldEdges).toBe(0);
    expect(v.inconsistentEdges).toBe(0);
    expect(v.degenerateTriangles).toBe(0);
    const loops = boundaryLoops(t.mesh);
    expect(loops).toHaveLength(1);
    expect(new Set(loops[0])).toEqual(new Set(t.cervicalLoop));
  });

  it('has outward normals (closed volume is positive and valid)', () => {
    const closed = validateClosedMesh(closeCervix(t));
    expect(closed.ok).toBe(true);
    expect(closed.signedVolumeMm3).toBeGreaterThan(100);
  });

  it('starts the cervical loop at the most mesial vertex and runs CCW from +z', () => {
    const loop = t.cervicalLoop;
    const xs = [...loop].map((v) => P[v * 3]!);
    expect(xs[0]).toBe(Math.max(...xs));
    let area = 0;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i]!, b = loop[(i + 1) % loop.length]!;
      area += P[a * 3]! * P[b * 3 + 1]! - P[b * 3]! * P[a * 3 + 1]!;
      expect(P[a * 3 + 2]).toBe(0);
    }
    expect(area).toBeGreaterThan(0);
  });

  it('has monotone height fractions along each column', () => {
    const byColumn = new Map<number, number[]>();
    for (let v = 0; v < t.column.length; v++) {
      const list = byColumn.get(t.column[v]!) ?? [];
      list.push(v);
      byColumn.set(t.column[v]!, list);
    }
    for (const vs of byColumn.values()) {
      for (let k = 1; k < vs.length; k++) expect(t.heightFraction[vs[k]!]!).toBeGreaterThanOrEqual(t.heightFraction[vs[k - 1]!]!);
    }
    for (const v of t.cervicalLoop) expect(t.heightFraction[v]).toBe(0);
    expect(Math.max(...t.heightFraction)).toBe(1);
  });

  it('matches its nominal size within 15%', () => {
    const [x, y, z] = boundsSize(computeBounds(P));
    expect(Math.abs(x - t.size.md) / t.size.md).toBeLessThan(0.15);
    expect(Math.abs(y - t.size.bl) / t.size.bl).toBeLessThan(0.15);
    expect(Math.abs(z - t.size.height) / t.size.height).toBeLessThan(0.15);
    console.info(
      `[template] ${t.id}: ${P.length / 3} vertices, ${t.mesh.indices.length / 3} triangles, bbox ${[x, y, z].map((s) => s.toFixed(2)).join(' × ')} mm, cusps ${t.cuspTips.map((c) => c.name).join('/')}`,
    );
  });

  it('places cusp tips on the occlusal surface, above the table', () => {
    expect(t.cuspTips).toHaveLength(type === 'molar' ? 4 : 2);
    for (const c of t.cuspTips) expect(c.p[2]).toBeGreaterThan(0.85 * t.size.height);
  });
});

describe('templateForTooth', () => {
  it('picks type and jaw from the FDI number and caches', () => {
    expect(templateForTooth(36).id).toBe('synthetic.lower-molar@1');
    expect(templateForTooth(46)).toBe(templateForTooth(36));
    expect(templateForTooth(15).id).toBe('synthetic.upper-premolar@1');
    expect(templateForTooth(27).id).toBe('synthetic.upper-molar@1');
    expect(templateForTooth(44).id).toBe('synthetic.lower-premolar@1');
    expect(() => templateForTooth(11)).toThrow(/not a premolar or molar/);
  });
});

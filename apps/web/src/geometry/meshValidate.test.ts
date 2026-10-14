import { describe, expect, it } from 'vitest';
import { validateClosedMesh } from './meshValidate';
import { cube } from './testMeshes';

const flip = (indices: Uint32Array, faces = indices.length / 3) => {
  const out = indices.slice();
  for (let f = 0; f < faces * 3; f += 3) [out[f + 1], out[f + 2]] = [out[f + 2]!, out[f + 1]!];
  return out;
};

describe('validateClosedMesh', () => {
  it('accepts a closed, outward cube', () => {
    const v = validateClosedMesh(cube(1));
    expect(v).toMatchObject({ boundaryEdges: 0, nonManifoldEdges: 0, inconsistentEdges: 0, closed: true, oriented: true, ok: true });
    expect(v.signedVolumeMm3).toBeCloseTo(1, 9);
  });

  it('rejects open, inconsistently wound and inside-out meshes', () => {
    const m = cube(1);
    const open = validateClosedMesh({ positions: m.positions, indices: m.indices.slice(6) }); // drop the bottom face
    expect(open).toMatchObject({ boundaryEdges: 4, closed: false, ok: false });
    const oneFlipped = validateClosedMesh({ positions: m.positions, indices: flip(m.indices, 1) });
    expect(oneFlipped).toMatchObject({ oriented: false, ok: false });
    const insideOut = validateClosedMesh({ positions: m.positions, indices: flip(m.indices) });
    expect(insideOut).toMatchObject({ closed: true, oriented: true, ok: false });
    expect(insideOut.signedVolumeMm3).toBeCloseTo(-1, 9);
  });
});

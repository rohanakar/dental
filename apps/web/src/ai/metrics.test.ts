import { describe, expect, it, vi } from 'vitest';

vi.mock('../tools/crownTool', () => ({ crownTool: { evaluate: vi.fn(async () => null) } }));

const { metricsFrom, reduceCrownMaps } = await import('./metrics');

describe('crown map → metrics reduction', () => {
  // Vertex 0 is intaglio (ignored); 1–2 are mesial of the centre, 3–4 distal (mesial = +x).
  const positions = new Float32Array([0, 0, 0, 2, 0, 0, 1, 0, 1, -2, 0, 0, -1, 0, 1]);
  const nan = Number.NaN;

  it('takes minima over shell vertices and splits proximal values by side', () => {
    const r = reduceCrownMaps({
      positions,
      shellStart: 1,
      occlusion: new Float32Array([-9, nan, 0.123, nan, 0.4]),
      proximal: new Float32Array([-9, 0.051, nan, -0.034, 0.2]),
      centre: [0, 0, 0],
      mesial: [1, 0, 0],
    });
    expect(r).toEqual({ minOcclusalClearanceMm: 0.12, mesialContactMm: 0.05, distalContactMm: -0.03 });
  });

  it('returns null for maps without values', () => {
    const r = reduceCrownMaps({ positions, shellStart: 1, occlusion: new Float32Array(5).fill(nan), centre: [0, 0, 0], mesial: [1, 0, 0] });
    expect(r).toEqual({ minOcclusalClearanceMm: null, mesialContactMm: null, distalContactMm: null });
  });

  it('reports margin length without a crown', () => {
    const tooth = {
      fdi: 36,
      params: {} as never,
      steps: {} as never,
      margin: { anchors: [], points: [{ p: [0, 0, 0] }, { p: [3, 0, 0] }, { p: [3, 4, 0] }], source: 'manual' },
    } as never;
    const m = metricsFrom(tooth, null);
    expect(m).toMatchObject({ fdi: 36, crownProposed: false, marginLengthMm: 12, minOcclusalClearanceMm: null, conflicts: [] });
  });
});

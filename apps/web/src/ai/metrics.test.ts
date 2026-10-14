import { describe, expect, it, vi } from 'vitest';

vi.mock('../tools/crownTool', () => ({ crownTool: { evaluate: vi.fn(async () => null) } }));

const { reduceCrownMaps } = await import('./metrics');

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
});

import { describe, expect, it } from 'vitest';
import { parsePly, writePly } from './ply';
import { cube } from './testMeshes';

const enc = (s: string) => new TextEncoder().encode(s);

describe('PLY', () => {
  it('parses ASCII PLY with colors and triangulates quads', () => {
    const text = [
      'ply',
      'format ascii 1.0',
      'comment test',
      'element vertex 4',
      'property float x',
      'property float y',
      'property float z',
      'property uchar red',
      'property uchar green',
      'property uchar blue',
      'element face 1',
      'property list uchar int vertex_indices',
      'end_header',
      '0 0 0 255 0 0',
      '1 0 0 0 255 0',
      '1 1 0 0 0 255',
      '0 1 0 10 20 30',
      '4 0 1 2 3',
      '',
    ].join('\n');
    const mesh = parsePly(enc(text));
    expect(mesh.positions.length / 3).toBe(4);
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2, 0, 2, 3]);
    expect(Array.from(mesh.colors!.subarray(9, 12))).toEqual([10, 20, 30]);
  });

  it('round-trips binary little-endian PLY with colors', () => {
    const src = cube(3);
    src.colors = new Uint8Array(8 * 3).map((_, i) => (i * 37) % 256);
    const mesh = parsePly(writePly(src));
    expect(mesh.positions).toEqual(src.positions);
    expect(mesh.indices).toEqual(src.indices);
    expect(mesh.colors).toEqual(src.colors);
  });
});

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

  it('parses binary big-endian PLY with double coordinates, float colors and extra properties', () => {
    const header = enc(
      [
        'ply',
        'format binary_big_endian 1.0',
        'element vertex 3',
        'property double x',
        'property double y',
        'property double z',
        'property float red',
        'property float green',
        'property float blue',
        'property float confidence',
        'element face 1',
        'property uchar flags',
        'property list uchar uint vertex_indices',
        'end_header',
        '',
      ].join('\n'),
    );
    const body = new DataView(new ArrayBuffer(3 * (24 + 16) + 1 + 1 + 12));
    let o = 0;
    const verts = [
      [0, 0, 0, 1, 0, 0],
      [2, 0, 0, 0, 1, 0],
      [0, 2, 0, 0, 0, 0.5],
    ];
    for (const [x, y, z, r, g, b] of verts) {
      for (const v of [x!, y!, z!]) {
        body.setFloat64(o, v, false);
        o += 8;
      }
      for (const c of [r!, g!, b!, 0.9]) {
        body.setFloat32(o, c, false);
        o += 4;
      }
    }
    body.setUint8(o++, 7); // flags
    body.setUint8(o++, 3);
    for (const i of [0, 1, 2]) {
      body.setUint32(o, i, false);
      o += 4;
    }
    const bytes = new Uint8Array(header.length + body.byteLength);
    bytes.set(header);
    bytes.set(new Uint8Array(body.buffer), header.length);
    const mesh = parsePly(bytes);
    expect(Array.from(mesh.positions)).toEqual([0, 0, 0, 2, 0, 0, 0, 2, 0]);
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2]);
    expect(Array.from(mesh.colors!)).toEqual([255, 0, 0, 0, 255, 0, 0, 0, 128]);
  });

  it('rejects faces that reference missing vertices', () => {
    const text = 'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n3 0 1 2\n';
    expect(() => parsePly(enc(text))).toThrow(/references vertex/);
  });
});

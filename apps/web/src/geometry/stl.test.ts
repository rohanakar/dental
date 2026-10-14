import { describe, expect, it } from 'vitest';
import { isBinaryStl, parseStl, writeBinaryStl } from './stl';
import { cube } from './testMeshes';
import { weldSoup } from './weld';

function asciiStl(soup: Float32Array): Uint8Array {
  let text = 'solid test\n';
  for (let f = 0; f < soup.length / 9; f++) {
    text += '  facet normal 0 0 0\n    outer loop\n';
    for (let k = 0; k < 3; k++) {
      const o = f * 9 + k * 3;
      text += `      vertex ${soup[o]} ${soup[o + 1]} ${soup[o + 2]}\n`;
    }
    text += '    endloop\n  endfacet\n';
  }
  text += 'endsolid test\n';
  return new TextEncoder().encode(text);
}

describe('STL', () => {
  it('parses binary STL (even with a "solid" header) and ASCII STL', () => {
    const bytes = writeBinaryStl(cube(2), 'solid but actually binary');
    expect(isBinaryStl(bytes)).toBe(true);
    const binary = parseStl(bytes);
    expect(binary.positions.length).toBe(12 * 9);
    expect(Math.max(...binary.positions)).toBe(2);
    expect(parseStl(asciiStl(binary.positions)).positions).toEqual(binary.positions);
  });

  it('welds a cube soup into 8 vertices and 12 faces', () => {
    const mesh = weldSoup(parseStl(writeBinaryStl(cube(1))));
    expect(mesh.positions.length / 3).toBe(8);
    expect(mesh.indices.length / 3).toBe(12);
  });
});

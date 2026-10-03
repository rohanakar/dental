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
  it('round-trips binary STL', () => {
    const bytes = writeBinaryStl(cube(2));
    expect(isBinaryStl(bytes)).toBe(true);
    const soup = parseStl(bytes);
    expect(soup.positions.length).toBe(12 * 9);
    expect(Math.max(...soup.positions)).toBe(2);
  });

  it('detects binary STL whose header starts with "solid"', () => {
    const bytes = writeBinaryStl(cube(1), 'solid but actually binary');
    expect(isBinaryStl(bytes)).toBe(true);
    expect(parseStl(bytes).positions.length).toBe(12 * 9);
  });

  it('parses ASCII STL', () => {
    const binary = parseStl(writeBinaryStl(cube(1.5)));
    const ascii = parseStl(asciiStl(binary.positions));
    expect(ascii.positions).toEqual(binary.positions);
  });

  it('welds a cube soup into 8 vertices and 12 faces', () => {
    const mesh = weldSoup(parseStl(writeBinaryStl(cube(1))));
    expect(mesh.positions.length / 3).toBe(8);
    expect(mesh.indices.length / 3).toBe(12);
  });

  it('treats -0 and +0 as the same vertex', () => {
    const soup = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, -0, -0, -0, 0, 1, 0, 1, 0, 0]);
    const mesh = weldSoup({ positions: soup });
    expect(mesh.positions.length / 3).toBe(3);
  });
});

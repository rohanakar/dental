import type { IndexedMesh } from './mesh';

type ScalarType = 'int8' | 'uint8' | 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32' | 'float64';

const TYPE_ALIASES: Record<string, ScalarType> = {
  char: 'int8', int8: 'int8',
  uchar: 'uint8', uint8: 'uint8',
  short: 'int16', int16: 'int16',
  ushort: 'uint16', uint16: 'uint16',
  int: 'int32', int32: 'int32',
  uint: 'uint32', uint32: 'uint32',
  float: 'float32', float32: 'float32',
  double: 'float64', float64: 'float64',
};

const TYPE_SIZE: Record<ScalarType, number> = {
  int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, float32: 4, float64: 8,
};

interface PlyProperty {
  name: string;
  type: ScalarType;
  /** Present for list properties: type of the count prefix. */
  countType?: ScalarType;
}

interface PlyElement {
  name: string;
  count: number;
  properties: PlyProperty[];
}

type Format = 'ascii' | 'binary_little_endian' | 'binary_big_endian';

interface PlyHeader {
  format: Format;
  elements: PlyElement[];
  /** Byte offset where the body starts. */
  bodyOffset: number;
}

function parseType(t: string | undefined): ScalarType {
  const type = t ? TYPE_ALIASES[t] : undefined;
  if (!type) throw new Error(`PLY: unsupported property type "${t}"`);
  return type;
}

function parseHeader(bytes: Uint8Array): PlyHeader {
  // Header is ASCII and ends with "end_header" + newline.
  const limit = Math.min(bytes.byteLength, 64 * 1024);
  const text = new TextDecoder('latin1').decode(bytes.subarray(0, limit));
  const end = text.indexOf('end_header');
  if (!text.startsWith('ply') || end < 0) throw new Error('PLY: missing header');
  let bodyOffset = end + 'end_header'.length;
  if (text[bodyOffset] === '\r') bodyOffset++;
  if (text[bodyOffset] === '\n') bodyOffset++;

  let format: Format | undefined;
  const elements: PlyElement[] = [];
  for (const raw of text.slice(0, end).split(/\r?\n/)) {
    const parts = raw.trim().split(/\s+/);
    switch (parts[0]) {
      case 'format':
        if (parts[1] !== 'ascii' && parts[1] !== 'binary_little_endian' && parts[1] !== 'binary_big_endian') {
          throw new Error(`PLY: unsupported format "${parts[1]}"`);
        }
        format = parts[1];
        break;
      case 'element':
        elements.push({ name: parts[1] ?? '', count: Number(parts[2]), properties: [] });
        break;
      case 'property': {
        const el = elements[elements.length - 1];
        if (!el) throw new Error('PLY: property before element');
        if (parts[1] === 'list') {
          el.properties.push({ name: parts[4] ?? '', countType: parseType(parts[2]), type: parseType(parts[3]) });
        } else {
          el.properties.push({ name: parts[2] ?? '', type: parseType(parts[1]) });
        }
        break;
      }
      default:
        break; // ply, comment, obj_info
    }
  }
  if (!format) throw new Error('PLY: missing format line');
  return { format, elements, bodyOffset };
}

/** Sequential reader over a binary or ASCII body. */
interface Reader {
  read(type: ScalarType): number;
}

function binaryReader(bytes: Uint8Array, offset: number, littleEndian: boolean): Reader & { offset: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const r = {
    offset,
    read(type: ScalarType): number {
      const o = r.offset;
      r.offset += TYPE_SIZE[type];
      switch (type) {
        case 'int8': return view.getInt8(o);
        case 'uint8': return view.getUint8(o);
        case 'int16': return view.getInt16(o, littleEndian);
        case 'uint16': return view.getUint16(o, littleEndian);
        case 'int32': return view.getInt32(o, littleEndian);
        case 'uint32': return view.getUint32(o, littleEndian);
        case 'float32': return view.getFloat32(o, littleEndian);
        case 'float64': return view.getFloat64(o, littleEndian);
      }
    },
  };
  return r;
}

function asciiReader(bytes: Uint8Array, offset: number): Reader {
  const tokens = new TextDecoder('latin1').decode(bytes.subarray(offset)).split(/\s+/).filter((t) => t.length > 0);
  let i = 0;
  return {
    read(): number {
      if (i >= tokens.length) throw new Error('PLY: unexpected end of ASCII body');
      return Number(tokens[i++]);
    },
  };
}

const COLOR_NAMES = {
  r: ['red', 'diffuse_red', 'r'],
  g: ['green', 'diffuse_green', 'g'],
  b: ['blue', 'diffuse_blue', 'b'],
};

export function parsePly(bytes: Uint8Array): IndexedMesh {
  const header = parseHeader(bytes);
  const reader =
    header.format === 'ascii'
      ? asciiReader(bytes, header.bodyOffset)
      : binaryReader(bytes, header.bodyOffset, header.format === 'binary_little_endian');

  let positions: Float32Array | undefined;
  let colors: Uint8Array | undefined;
  const indices: number[] = [];

  for (const el of header.elements) {
    if (el.name === 'vertex') {
      const props = el.properties;
      const ix = props.findIndex((p) => p.name === 'x');
      const iy = props.findIndex((p) => p.name === 'y');
      const iz = props.findIndex((p) => p.name === 'z');
      if (ix < 0 || iy < 0 || iz < 0) throw new Error('PLY: vertex element lacks x/y/z');
      const ir = props.findIndex((p) => COLOR_NAMES.r.includes(p.name));
      const ig = props.findIndex((p) => COLOR_NAMES.g.includes(p.name));
      const ib = props.findIndex((p) => COLOR_NAMES.b.includes(p.name));
      const hasColor = ir >= 0 && ig >= 0 && ib >= 0;
      const colorScale = hasColor && props[ir]!.type.startsWith('float') ? 255 : 1;
      positions = new Float32Array(el.count * 3);
      colors = hasColor ? new Uint8Array(el.count * 3) : undefined;
      const row = new Float64Array(props.length);
      for (let v = 0; v < el.count; v++) {
        for (let p = 0; p < props.length; p++) {
          const prop = props[p]!;
          if (prop.countType) {
            const n = reader.read(prop.countType);
            for (let k = 0; k < n; k++) reader.read(prop.type);
            row[p] = 0;
          } else {
            row[p] = reader.read(prop.type);
          }
        }
        positions[v * 3] = row[ix]!;
        positions[v * 3 + 1] = row[iy]!;
        positions[v * 3 + 2] = row[iz]!;
        if (colors) {
          colors[v * 3] = clampByte(row[ir]! * colorScale);
          colors[v * 3 + 1] = clampByte(row[ig]! * colorScale);
          colors[v * 3 + 2] = clampByte(row[ib]! * colorScale);
        }
      }
    } else if (el.name === 'face') {
      const props = el.properties;
      const listIdx = props.findIndex((p) => p.countType && (p.name === 'vertex_indices' || p.name === 'vertex_index'));
      if (listIdx < 0) throw new Error('PLY: face element lacks vertex_indices');
      const poly: number[] = [];
      for (let f = 0; f < el.count; f++) {
        for (let p = 0; p < props.length; p++) {
          const prop = props[p]!;
          if (prop.countType) {
            const n = reader.read(prop.countType);
            if (p === listIdx) {
              poly.length = 0;
              for (let k = 0; k < n; k++) poly.push(reader.read(prop.type));
            } else {
              for (let k = 0; k < n; k++) reader.read(prop.type);
            }
          } else {
            reader.read(prop.type);
          }
        }
        // Fan triangulation for polygons.
        for (let k = 1; k + 1 < poly.length; k++) indices.push(poly[0]!, poly[k]!, poly[k + 1]!);
      }
    } else {
      // Skip unknown elements (edges, materials, ...).
      for (let i = 0; i < el.count; i++) {
        for (const prop of el.properties) {
          if (prop.countType) {
            const n = reader.read(prop.countType);
            for (let k = 0; k < n; k++) reader.read(prop.type);
          } else {
            reader.read(prop.type);
          }
        }
      }
    }
  }

  if (!positions) throw new Error('PLY: no vertex element');
  const vcount = positions.length / 3;
  const idx = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i]!;
    if (v < 0 || v >= vcount) throw new Error(`PLY: face references vertex ${v} of ${vcount}`);
    idx[i] = v;
  }
  return { positions, indices: idx, colors };
}

const clampByte = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** Binary little-endian PLY writer with optional vertex colors. */
export function writePly(mesh: IndexedMesh): Uint8Array {
  const vcount = mesh.positions.length / 3;
  const fcount = mesh.indices.length / 3;
  const header =
    'ply\nformat binary_little_endian 1.0\ncomment dcad\n' +
    `element vertex ${vcount}\nproperty float x\nproperty float y\nproperty float z\n` +
    (mesh.colors ? 'property uchar red\nproperty uchar green\nproperty uchar blue\n' : '') +
    `element face ${fcount}\nproperty list uchar int vertex_indices\nend_header\n`;
  const headerBytes = new TextEncoder().encode(header);
  const vsize = 12 + (mesh.colors ? 3 : 0);
  const bytes = new Uint8Array(headerBytes.length + vcount * vsize + fcount * 13);
  bytes.set(headerBytes);
  const view = new DataView(bytes.buffer);
  let o = headerBytes.length;
  for (let v = 0; v < vcount; v++) {
    view.setFloat32(o, mesh.positions[v * 3]!, true);
    view.setFloat32(o + 4, mesh.positions[v * 3 + 1]!, true);
    view.setFloat32(o + 8, mesh.positions[v * 3 + 2]!, true);
    o += 12;
    if (mesh.colors) {
      bytes[o] = mesh.colors[v * 3]!;
      bytes[o + 1] = mesh.colors[v * 3 + 1]!;
      bytes[o + 2] = mesh.colors[v * 3 + 2]!;
      o += 3;
    }
  }
  for (let f = 0; f < fcount; f++) {
    view.setUint8(o, 3);
    view.setInt32(o + 1, mesh.indices[f * 3]!, true);
    view.setInt32(o + 5, mesh.indices[f * 3 + 1]!, true);
    view.setInt32(o + 9, mesh.indices[f * 3 + 2]!, true);
    o += 13;
  }
  return bytes;
}

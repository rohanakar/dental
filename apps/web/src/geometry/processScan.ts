import { cleanupMesh, type CleanupStats } from './cleanup';
import { boundsSize, computeBounds, type Bounds, type IndexedMesh, type TriangleSoup } from './mesh';
import { computeVertexNormals } from './normals';
import { parsePly } from './ply';
import { isBinaryStl, parseStl } from './stl';
import { weldIndexed, weldSoup } from './weld';

export type ScanFormat = 'stl-binary' | 'stl-ascii' | 'ply';

export interface ScanStats extends CleanupStats {
  format: ScanFormat;
  inputTriangles: number;
  triangles: number;
  vertices: number;
  hasColors: boolean;
  bounds: Bounds;
  /** Bounding-box extents in mm. */
  sizeMm: [number, number, number];
  timingsMs: { parse: number; weld: number; cleanup: number; normals: number; total: number };
}

export interface ProcessedScan {
  mesh: IndexedMesh & { normals: Float32Array };
  stats: ScanStats;
  warnings: string[];
  /** sha256 of the original file bytes (hex). */
  sha256: string;
}

/** Arch-sized scans are roughly 10-80 mm; outside this range the units are suspect. */
export const MAX_PLAUSIBLE_MM = 200;
export const MIN_PLAUSIBLE_MM = 5;

export function detectFormat(bytes: Uint8Array, fileName: string): ScanFormat {
  const lower = fileName.toLowerCase();
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4));
  if (lower.endsWith('.ply') || head.startsWith('ply')) return 'ply';
  if (lower.endsWith('.stl') || bytes.byteLength >= 84) return isBinaryStl(bytes) ? 'stl-binary' : 'stl-ascii';
  throw new Error(`Unsupported file type: ${fileName}`);
}

export function unitWarnings(sizeMm: [number, number, number]): string[] {
  const maxExtent = Math.max(...sizeMm);
  if (!Number.isFinite(maxExtent)) return ['Scan has no valid geometry.'];
  if (maxExtent > MAX_PLAUSIBLE_MM) {
    return [
      `Scan is ${maxExtent.toFixed(0)} mm across, which is too large for a dental arch. The file may use micrometres or another unit instead of millimetres.`,
    ];
  }
  if (maxExtent < MIN_PLAUSIBLE_MM) {
    return [
      `Scan is ${maxExtent.toFixed(2)} mm across, which is too small for a dental arch. The file may use centimetres or metres instead of millimetres.`,
    ];
  }
  return [];
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Import pipeline: parse → weld → cleanup → normals → stats/warnings.
 * Pure (no DOM, no three.js) so it runs in a worker and in Node tests.
 */
export async function processScan(bytes: Uint8Array, fileName: string): Promise<ProcessedScan> {
  const t0 = performance.now();
  // Hash first: later steps may reuse the underlying buffer.
  const sha256 = await sha256Hex(bytes);
  const format = detectFormat(bytes, fileName);

  const tp = performance.now();
  const parsed: { kind: 'indexed'; mesh: IndexedMesh } | { kind: 'soup'; soup: TriangleSoup } =
    format === 'ply' ? { kind: 'indexed', mesh: parsePly(bytes) } : { kind: 'soup', soup: parseStl(bytes) };
  const tParse = performance.now() - tp;
  const inputTriangles = parsed.kind === 'indexed' ? parsed.mesh.indices.length / 3 : parsed.soup.positions.length / 9;

  const tw = performance.now();
  const mesh = parsed.kind === 'indexed' ? weldIndexed(parsed.mesh) : weldSoup(parsed.soup);
  const tWeld = performance.now() - tw;

  const tc = performance.now();
  const cleaned = cleanupMesh(mesh);
  const tCleanup = performance.now() - tc;

  const tn = performance.now();
  const normals = computeVertexNormals(cleaned.mesh);
  const tNormals = performance.now() - tn;

  const bounds = computeBounds(cleaned.mesh.positions);
  const sizeMm = boundsSize(bounds);
  const triangles = cleaned.mesh.indices.length / 3;
  const warnings: string[] = [];
  if (triangles === 0) warnings.push('No usable triangles after cleanup.');
  else warnings.push(...unitWarnings(sizeMm));
  const removed = cleaned.stats.removedDegenerate + cleaned.stats.removedDuplicate;
  if (removed > 0) warnings.push(`Removed ${removed.toLocaleString()} degenerate or duplicate triangles.`);
  if (cleaned.stats.removedComponents > 0) {
    warnings.push(
      `Removed ${cleaned.stats.removedComponents.toLocaleString()} small disconnected fragment(s) (${cleaned.stats.removedSmallComponentFaces.toLocaleString()} triangles).`,
    );
  }

  return {
    mesh: { ...cleaned.mesh, normals },
    stats: {
      format,
      inputTriangles,
      triangles,
      vertices: cleaned.mesh.positions.length / 3,
      hasColors: Boolean(cleaned.mesh.colors),
      bounds,
      sizeMm,
      ...cleaned.stats,
      timingsMs: {
        parse: tParse,
        weld: tWeld,
        cleanup: tCleanup,
        normals: tNormals,
        total: performance.now() - t0,
      },
    },
    warnings,
    sha256,
  };
}

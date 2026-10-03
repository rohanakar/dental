import { BufferAttribute, BufferGeometry } from 'three';
import { MeshBVH, type SerializedBVH } from 'three-mesh-bvh';
import type { ProcessedScan, ScanStats } from '../geometry/processScan';

/**
 * What the geometry worker sends back for an imported scan. The BVH is built
 * in the worker; building it reorders the index buffer, so the serialized
 * BVH's index is the canonical triangle order. Face ids are only meaningful
 * against this order (and still should not be persisted; see MarginPoint).
 */
export interface ScanPayload {
  positions: Float32Array;
  normals: Float32Array;
  /** sRGB bytes per vertex, if the scan had colors. */
  colors?: Uint8Array;
  bvh: SerializedBVH;
  stats: ScanStats;
  warnings: string[];
  sha256: string;
  bvhMs: number;
}

/** Worker side: build the BVH and package buffers for zero-copy transfer. */
export function buildScanPayload(scan: ProcessedScan): { payload: ScanPayload; transfer: ArrayBuffer[] } {
  const t0 = performance.now();
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(scan.mesh.positions, 3));
  geometry.setIndex(new BufferAttribute(scan.mesh.indices, 1));
  const bvh = new MeshBVH(geometry, { indirect: false });
  const serialized = MeshBVH.serialize(bvh, { cloneBuffers: false });
  const bvhMs = performance.now() - t0;

  const payload: ScanPayload = {
    positions: scan.mesh.positions,
    normals: scan.mesh.normals,
    colors: scan.mesh.colors,
    bvh: serialized,
    stats: scan.stats,
    warnings: scan.warnings,
    sha256: scan.sha256,
    bvhMs,
  };
  const buffers = new Set<ArrayBuffer>();
  const add = (a: ArrayBufferView | null | undefined) => {
    if (a && a.buffer instanceof ArrayBuffer) buffers.add(a.buffer);
  };
  add(payload.positions);
  add(payload.normals);
  add(payload.colors);
  add(serialized.index);
  add(serialized.indirectBuffer);
  for (const root of serialized.roots) if (root instanceof ArrayBuffer) buffers.add(root);
  return { payload, transfer: [...buffers] };
}

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Main-thread side: rebuild a BufferGeometry with its BVH attached as boundsTree. */
export function geometryFromPayload(payload: ScanPayload): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(payload.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(payload.normals, 3));
  if (payload.colors) {
    // three.js treats vertex colors as linear; scanner colors are sRGB.
    const linear = new Float32Array(payload.colors.length);
    for (let i = 0; i < linear.length; i++) linear[i] = SRGB_TO_LINEAR[payload.colors[i]!]!;
    geometry.setAttribute('color', new BufferAttribute(linear, 3));
  }
  const index = payload.bvh.index;
  if (!index) throw new Error('Serialized BVH has no index');
  geometry.setIndex(new BufferAttribute(index, 1));
  geometry.boundsTree = MeshBVH.deserialize(payload.bvh, geometry, { setIndex: false });
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

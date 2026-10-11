import { BufferAttribute, BufferGeometry } from 'three';
import { MeshBVH, type SerializedBVH } from 'three-mesh-bvh';
import type { ScanPayload } from './scanPayload';

/**
 * Worker-side copies of imported scans, keyed by sha256. The import payload's
 * buffers are transferred to the main thread, so the worker clones them first
 * and keeps its own BVH for analysis (frame, live-wire, axis). Vertex ids and
 * the BVH-ordered index are identical on both sides.
 */
export interface RetainedScan {
  sha256: string;
  positions: Float32Array;
  normals: Float32Array;
  /** BVH-ordered triangle index (canonical face order). */
  indices: Uint32Array;
  bvh: MeshBVH;
  /** Lazily computed analysis results, cached per scan. */
  cache: Map<string, unknown>;
}

function cloneSerialized(bvh: SerializedBVH): SerializedBVH {
  return {
    ...bvh,
    roots: bvh.roots.map((r) => r.slice(0)),
    index: bvh.index ? (bvh.index.slice() as SerializedBVH['index']) : bvh.index,
    indirectBuffer: bvh.indirectBuffer ? (bvh.indirectBuffer.slice() as SerializedBVH['indirectBuffer']) : bvh.indirectBuffer,
  };
}

export class ScanRegistry {
  private readonly scans = new Map<string, RetainedScan>();

  /** Clone and keep a scan. Call before the payload's buffers are transferred. */
  retain(payload: ScanPayload): void {
    if (this.scans.has(payload.sha256)) return;
    const serialized = cloneSerialized(payload.bvh);
    const positions = payload.positions.slice();
    const normals = payload.normals.slice();
    const index = serialized.index;
    if (!index) throw new Error('Serialized BVH has no index');
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setIndex(new BufferAttribute(index, 1));
    const bvh = MeshBVH.deserialize(serialized, geometry, { setIndex: false });
    this.scans.set(payload.sha256, {
      sha256: payload.sha256,
      positions,
      normals,
      indices: new Uint32Array(index.buffer, index.byteOffset, index.length),
      bvh,
      cache: new Map(),
    });
  }

  get(sha256: string): RetainedScan {
    const scan = this.scans.get(sha256);
    if (!scan) throw new Error(`Scan ${sha256.slice(0, 8)}… is not loaded in the geometry worker`);
    return scan;
  }

  has(sha256: string): boolean {
    return this.scans.has(sha256);
  }

  release(sha256: string): void {
    this.scans.delete(sha256);
  }

  /** Memoize an analysis result on the scan. */
  cached<T>(scan: RetainedScan, key: string, compute: () => T): T {
    if (!scan.cache.has(key)) scan.cache.set(key, compute());
    return scan.cache.get(key) as T;
  }
}

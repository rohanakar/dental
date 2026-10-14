import { Ray, Triangle, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { describe, expect, it } from 'vitest';
import { processScan } from '../geometry/processScan';
import { writeBinaryStl } from '../geometry/stl';
import { syntheticArch } from '../geometry/synthetic';
import { buildScanPayload, geometryFromPayload } from './scanPayload';

describe('scan payload', () => {
  it('serializes the BVH in the worker and rebuilds it on the main thread', async () => {
    const arch = syntheticArch({ along: 200, across: 60 });
    const processed = await processScan(writeBinaryStl(arch), 'lower.stl');
    const { payload, transfer } = buildScanPayload(processed);
    expect(new Set(transfer).size).toBe(transfer.length); // no duplicate buffers in the transfer list
    const geometry = geometryFromPayload(structuredClone(payload));
    const bvh = geometry.boundsTree as MeshBVH;
    expect(bvh).toBeInstanceOf(MeshBVH);

    // A ray straight down onto the arch front must hit the surface.
    const ray = new Ray(new Vector3(0, 26, 50), new Vector3(0, 0, -1));
    const hit = bvh.raycastFirst(ray);
    expect(hit).not.toBeNull();
    expect(hit!.point.z).toBeGreaterThan(0);
    // The hit face, read from the canonical (BVH-ordered) index, contains the hit point.
    const idx = geometry.index!.array;
    const pos = geometry.getAttribute('position');
    const corner = (k: number) => new Vector3().fromBufferAttribute(pos, idx[hit!.faceIndex! * 3 + k]!);
    const tri = new Triangle(corner(0), corner(1), corner(2));
    expect(tri.closestPointToPoint(hit!.point, new Vector3()).distanceTo(hit!.point)).toBeLessThan(1e-4);
  });
});

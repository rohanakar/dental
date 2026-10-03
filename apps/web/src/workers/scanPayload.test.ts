import { Ray, Triangle, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { describe, expect, it } from 'vitest';
import { processScan } from '../geometry/processScan';
import { writeBinaryStl } from '../geometry/stl';
import { syntheticArch } from '../geometry/synthetic';
import { estimateViewFrame } from '../engine/viewFrame';
import { LatestWins, StaleResultError } from './latestWins';
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

  it('estimates a view frame for the synthetic jaws', async () => {
    const lower = await processScan(writeBinaryStl(syntheticArch({ jaw: 'lower', along: 200, across: 40 })), 'l.stl');
    const upper = await processScan(writeBinaryStl(syntheticArch({ jaw: 'upper', along: 200, across: 40 })), 'u.stl');
    const frame = estimateViewFrame([
      { role: 'lower', positions: lower.mesh.positions, normals: lower.mesh.normals },
      { role: 'upper', positions: upper.mesh.positions, normals: upper.mesh.normals },
    ])!;
    expect(frame.up[2]).toBeGreaterThan(0.95); // lower → upper is +z
    expect(frame.buccal[1]).toBeGreaterThan(0.95); // arch front is +y
    const lowerOnly = estimateViewFrame([{ role: 'lower', positions: lower.mesh.positions, normals: lower.mesh.normals }])!;
    expect(lowerOnly.up[2]).toBeGreaterThan(0.95);
    const upperOnly = estimateViewFrame([{ role: 'upper', positions: upper.mesh.positions, normals: upper.mesh.normals }])!;
    expect(upperOnly.up[2]).toBeGreaterThan(0.95);
    expect(upperOnly.occlusal[2]).toBeLessThan(-0.95);
  });
});

describe('LatestWins', () => {
  it('discards superseded results', async () => {
    const lw = new LatestWins();
    let release!: () => void;
    const slow = lw.run('k', () => new Promise<string>((r) => (release = () => r('old'))));
    const fast = lw.run('k', async () => 'new');
    await expect(fast).resolves.toBe('new');
    release();
    await expect(slow).rejects.toBeInstanceOf(StaleResultError);
  });
});

describe('1M-triangle import performance', () => {
  it('processes and builds the BVH for a ~1M-triangle STL', async () => {
    const arch = syntheticArch({ along: 1000, across: 500 });
    const bytes = writeBinaryStl(arch);
    const t0 = performance.now();
    const processed = await processScan(bytes, 'big.stl');
    const tProcess = performance.now() - t0;
    const t1 = performance.now();
    buildScanPayload(processed);
    const tBvh = performance.now() - t1;
    const total = tProcess + tBvh;
    console.info(
      `[perf] ${processed.stats.triangles.toLocaleString()} triangles (${(bytes.byteLength / 1e6).toFixed(0)} MB STL): ` +
        `process ${tProcess.toFixed(0)} ms (parse ${processed.stats.timingsMs.parse.toFixed(0)}, weld ${processed.stats.timingsMs.weld.toFixed(0)}, ` +
        `cleanup ${processed.stats.timingsMs.cleanup.toFixed(0)}, normals ${processed.stats.timingsMs.normals.toFixed(0)}) + BVH ${tBvh.toFixed(0)} ms = ${total.toFixed(0)} ms`,
    );
    expect(processed.stats.triangles).toBe(1_000_000);
    // Soft target: 5 s. Only fail on a gross regression.
    if (total > 5000) console.warn(`[perf] above the 5 s target: ${total.toFixed(0)} ms`);
    expect(total).toBeLessThan(20_000);
  });
});

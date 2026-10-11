import { BufferAttribute, BufferGeometry, DoubleSide, Ray, Vector3 } from 'three';
import { MeshBVH, type HitPointInfo } from 'three-mesh-bvh';
import type { V3 } from './pca';

export interface RayHit {
  distance: number;
  point: V3;
  /** Face index in the BVH-ordered index buffer. */
  faceIndex: number;
  /** Unit geometric face normal from the triangle winding (outward for consistently wound scans). */
  normal: V3;
}

export interface ClosestPoint {
  point: V3;
  faceIndex: number;
  distance: number;
}

/**
 * The only surface query geometry algorithms depend on. Backed by
 * three-mesh-bvh in the worker, on the main thread and in Node tools.
 * Directions must be unit vectors. Both front and back faces are hit.
 */
export interface RayCaster {
  /** First hit along the ray within (0, far]. */
  first(origin: V3, dir: V3, far?: number): RayHit | null;
  /** All hits along the ray within (0, far], sorted by distance. */
  all(origin: V3, dir: V3, far?: number): RayHit[];
  /** Closest surface point to p, or null if none within maxDistance. */
  closestPoint(p: V3, maxDistance?: number): ClosestPoint | null;
}

/**
 * Build a BVH over an indexed mesh. three-mesh-bvh reorders `indices` in
 * place; that order is canonical afterwards (face ids refer to it).
 */
export function createBvh(mesh: { positions: Float32Array; indices: Uint32Array }): MeshBVH {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  geometry.setIndex(new BufferAttribute(mesh.indices, 1));
  return new MeshBVH(geometry, { indirect: false });
}

/** RayCaster over a three-mesh-bvh BVH (non-indirect, so its geometry index is the canonical face order). */
export function bvhRayCaster(bvh: MeshBVH): RayCaster {
  const ray = new Ray();
  const target = new Vector3();
  const info: HitPointInfo = { point: new Vector3(), distance: 0, faceIndex: 0 };
  const toHit = (h: { distance: number; point: Vector3; faceIndex?: number | null; face?: { normal: Vector3 } | null }): RayHit => ({
    distance: h.distance,
    point: [h.point.x, h.point.y, h.point.z],
    faceIndex: h.faceIndex ?? -1,
    normal: h.face ? [h.face.normal.x, h.face.normal.y, h.face.normal.z] : [0, 0, 0],
  });
  const setRay = (o: V3, d: V3) => {
    ray.origin.set(o[0], o[1], o[2]);
    ray.direction.set(d[0], d[1], d[2]);
  };
  return {
    first(origin, dir, far = Infinity) {
      setRay(origin, dir);
      const hit = bvh.raycastFirst(ray, DoubleSide, 0, far);
      return hit ? toHit(hit) : null;
    },
    all(origin, dir, far = Infinity) {
      setRay(origin, dir);
      return bvh
        .raycast(ray, DoubleSide, 0, far)
        .map(toHit)
        .sort((a, b) => a.distance - b.distance);
    },
    closestPoint(p, maxDistance = Infinity) {
      target.set(p[0], p[1], p[2]);
      const hit = bvh.closestPointToPoint(target, info, 0, maxDistance);
      if (!hit) return null;
      return { point: [hit.point.x, hit.point.y, hit.point.z], faceIndex: hit.faceIndex, distance: hit.distance };
    },
  };
}

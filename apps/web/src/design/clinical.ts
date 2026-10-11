import type { ClinicalAxis, ClinicalDirection, Pose, ToothFrame } from '@dcad/shared';
import { templateForTooth } from '../geometry/crownTemplate';

/**
 * Pure pose math for the clinical crown commands (moveCrown, rotateCrown,
 * scaleCrown). Directions and axes come from the tooth frame, so "mesial"
 * means the same thing for every quadrant. Quaternions are [x, y, z, w].
 */
export type V3 = [number, number, number];
export type Quat = [number, number, number, number];

const len = (v: readonly number[]) => Math.hypot(v[0]!, v[1]!, v[2]!);
export const normalize3 = (v: readonly number[]): V3 => {
  const l = len(v) || 1;
  return [v[0]! / l, v[1]! / l, v[2]! / l];
};

export function quatNormalize(q: readonly number[]): Quat {
  const l = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!) || 1;
  return [q[0]! / l, q[1]! / l, q[2]! / l, q[3]! / l];
}

/** a ⊗ b: apply b first, then a. */
export function quatMultiply(a: readonly number[], b: readonly number[]): Quat {
  const [ax, ay, az, aw] = a as Quat;
  const [bx, by, bz, bw] = b as Quat;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Right-hand rotation of `deg` degrees about a (not necessarily unit) axis. */
export function quatFromAxisAngle(axis: readonly number[], deg: number): Quat {
  const a = normalize3(axis);
  const half = (deg * Math.PI) / 360;
  const s = Math.sin(half);
  return [a[0] * s, a[1] * s, a[2] * s, Math.cos(half)];
}

/** Rotate v by unit quaternion q. */
export function quatRotate(q: readonly number[], v: readonly number[]): V3 {
  const [x, y, z, w] = q as Quat;
  // t = 2 · (q.xyz × v); v' = v + w·t + q.xyz × t
  const tx = 2 * (y * v[2]! - z * v[1]!);
  const ty = 2 * (z * v[0]! - x * v[2]!);
  const tz = 2 * (x * v[1]! - y * v[0]!);
  return [v[0]! + w * tx + (y * tz - z * ty), v[1]! + w * ty + (z * tx - x * tz), v[2]! + w * tz + (x * ty - y * tx)];
}

type FrameAxes = Pick<ToothFrame, 'mesial' | 'buccal' | 'occlusal'>;

/** World unit vector for a clinical direction in this tooth's frame. */
export function directionVector(frame: FrameAxes, direction: ClinicalDirection): V3 {
  switch (direction) {
    case 'mesial':
      return normalize3(frame.mesial);
    case 'distal':
      return normalize3(frame.mesial.map((x) => -x));
    case 'buccal':
      return normalize3(frame.buccal);
    case 'lingual':
      return normalize3(frame.buccal.map((x) => -x));
    case 'occlusal':
      return normalize3(frame.occlusal);
    case 'cervical':
      return normalize3(frame.occlusal.map((x) => -x));
  }
}

/** World unit vector for a clinical rotation/scale axis. */
export function axisVector(frame: FrameAxes, axis: ClinicalAxis): V3 {
  return axis === 'mesial-distal' ? normalize3(frame.mesial) : axis === 'buccal-lingual' ? normalize3(frame.buccal) : normalize3(frame.occlusal);
}

/** Pose scale component for a clinical axis: template x = mesial-distal, y = buccal-lingual, z = occlusal. */
export const scaleIndex = (axis: ClinicalAxis): 0 | 1 | 2 => (axis === 'mesial-distal' ? 0 : axis === 'buccal-lingual' ? 1 : 2);

/** Nominal (unscaled) height of the library template for a tooth, mm. */
export function templateHeight(fdi: number): number {
  return templateForTooth(fdi).size.height;
}

/** Crown mid-height centre: c = position + R·S·(0, 0, h/2). The template origin is the cervical centroid. */
export function crownCentre(pose: Pose, templateHeightMm: number): V3 {
  const up = quatRotate(pose.quaternion, [0, 0, (pose.scale[2] * templateHeightMm) / 2]);
  return [pose.position[0] + up[0], pose.position[1] + up[1], pose.position[2] + up[2]];
}

export function movePose(pose: Pose, direction: readonly number[], mm: number): Pose {
  return {
    ...pose,
    position: [pose.position[0] + direction[0]! * mm, pose.position[1] + direction[1]! * mm, pose.position[2] + direction[2]! * mm],
  };
}

/** Right-hand rotation about a world axis through `centre`. */
export function rotatePose(pose: Pose, axis: readonly number[], deg: number, centre: readonly number[]): Pose {
  const r = quatFromAxisAngle(axis, deg);
  const rel = [pose.position[0] - centre[0]!, pose.position[1] - centre[1]!, pose.position[2] - centre[2]!];
  const moved = quatRotate(r, rel);
  return {
    ...pose,
    position: [centre[0]! + moved[0], centre[1]! + moved[1], centre[2]! + moved[2]],
    quaternion: quatNormalize(quatMultiply(r, pose.quaternion)),
  };
}

/** Multiply one scale component by (1 + pct/100); the sign (mirroring) is kept. */
export function scalePose(pose: Pose, index: 0 | 1 | 2, pct: number): Pose {
  const scale: V3 = [...pose.scale];
  scale[index] = scale[index] * (1 + pct / 100);
  return { ...pose, scale };
}

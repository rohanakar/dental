import { jawOf, type ScanRole, type ToothDesign } from '@dcad/shared';
import type { BufferGeometry } from 'three';
import { useDesignStore } from '../design/store';
import { sceneController } from '../state/sceneController';
import type { V3 } from './toolStore';

export interface JawContext {
  role: ScanRole;
  sha256: string;
  geometry: BufferGeometry;
}

export interface ToothContext {
  fdi: number;
  tooth: ToothDesign;
  /** The jaw that carries the prep. */
  jaw: JawContext;
  antagonist: JawContext | null;
}

const antagonistRole = (role: 'upper' | 'lower'): ScanRole => (role === 'upper' ? 'lower' : 'upper');

/** Active tooth plus its loaded jaw scans, or null when the prep jaw is not loaded. */
export function toothContext(): ToothContext | null {
  return toothContextFor(useDesignStore.getState().activeFdi);
}

/** Any tooth of the current document plus its loaded jaw scans (e.g. to design every restoration for an export). */
export function toothContextFor(fdi: number): ToothContext | null {
  const tooth = useDesignStore.getState().doc.teeth.find((t) => t.fdi === fdi);
  if (!tooth) return null;
  const role = jawOf(tooth.fdi);
  const jaw = sceneController.geometryFor(role);
  if (!jaw) return null;
  const antagonist = sceneController.geometryFor(antagonistRole(role));
  return {
    fdi: tooth.fdi,
    tooth,
    jaw: { role, ...jaw },
    antagonist: antagonist ? { role: antagonistRole(role), ...antagonist } : null,
  };
}

/** Vertex of a hit face closest to the hit point (vertex ids are shared with the worker). */
export function nearestCorner(geometry: BufferGeometry, faceIndex: number, point: { x: number; y: number; z: number }): number {
  const index = geometry.index!.array;
  const pos = geometry.getAttribute('position').array as Float32Array;
  let best = index[faceIndex * 3]!;
  let bestD = Infinity;
  for (let k = 0; k < 3; k++) {
    const v = index[faceIndex * 3 + k]!;
    const d = (pos[v * 3]! - point.x) ** 2 + (pos[v * 3 + 1]! - point.y) ** 2 + (pos[v * 3 + 2]! - point.z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = v;
    }
  }
  return best;
}

export function vertexPosition(geometry: BufferGeometry, v: number): V3 {
  const pos = geometry.getAttribute('position').array as Float32Array;
  return [pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!];
}

/** xyz of a vertex path, for drawing. */
export function pathPositions(geometry: BufferGeometry, path: readonly number[]): Float32Array {
  const pos = geometry.getAttribute('position').array as Float32Array;
  const out = new Float32Array(path.length * 3);
  path.forEach((v, i) => out.set(pos.subarray(v * 3, v * 3 + 3), i * 3));
  return out;
}

/** Flat xyz → MarginPoint list (rounded to 0.1 µm to keep documents small). */
export function toMarginPoints(points: Float32Array): Array<{ p: V3 }> {
  const r = (x: number) => Math.round(x * 1e4) / 1e4;
  const out: Array<{ p: V3 }> = [];
  for (let i = 0; i + 2 < points.length; i += 3) out.push({ p: [r(points[i]!), r(points[i + 1]!), r(points[i + 2]!)] });
  return out;
}

export function fromMarginPoints(points: ReadonlyArray<{ p: readonly [number, number, number] }>): Float32Array {
  const out = new Float32Array(points.length * 3);
  points.forEach((m, i) => out.set(m.p, i * 3));
  return out;
}

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

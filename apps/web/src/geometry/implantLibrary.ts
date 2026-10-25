import type { Pose } from '@dcad/shared';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { z } from 'zod';
import type { IndexedMesh } from './mesh';
import { validateClosedMesh } from './meshValidate';
import type { V3 } from './pca';
import { bvhRayCaster, createBvh } from './raycast';
import { parseStl, writeBinaryStl } from './stl';
import { weldSoup } from './weld';

/**
 * Implant libraries: the scan body, Ti-base and screw of one implant system
 * and platform, in dcad's own documented format (no vendor format is read).
 *
 * On disk a library is a directory:
 *
 *   <library-id>/library.json        manifest (ImplantLibraryManifest)
 *   <library-id>/<entry>.scan-body.stl
 *   <library-id>/<entry>.ti-base.stl
 *   <library-id>/<entry>.screw.stl   (optional)
 *
 * Every mesh is a closed, outward-oriented binary STL in the **library
 * frame**: millimetres, the origin at the centre of the implant platform,
 * the implant axis along +z (pointing out of the implant, toward the
 * restoration) and the anti-rotation flat (scan-body flat, engaging feature)
 * facing +x. A pose (ImplantPose) maps this frame into the scan.
 *
 * Libraries live in data/implant-libraries/ (gitignored). The repo ships only
 * a synthetic generic library, written by tools/fixtures/implant-library.mts;
 * vendor libraries need the vendor's permission.
 */

export const IMPLANT_LIBRARY_FORMAT = 'dcad.implant-library';
export const IMPLANT_LIBRARY_MANIFEST = 'library.json';
/** Default height (mm, from the scan body top down) of the part of a scan body that is always above the gingiva. */
export const DEFAULT_SCAN_REGION_HEIGHT_MM = 5;
/** Largest distance (mm) from a shoulder-loop point to the Ti-base surface accepted on load. */
const SHOULDER_ON_TI_BASE_MM = 0.05;

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
/** A relative path inside the library directory: no leading slash, no "..". */
const LibraryPath = z
  .string()
  .regex(/^[A-Za-z0-9._@-]+(\/[A-Za-z0-9._@-]+)*$/, 'a relative path inside the library')
  .refine((p) => !p.split('/').includes('..'), 'a relative path inside the library');

export const ImplantLibraryEntryManifest = z.object({
  /** Unique within the library, e.g. 'rp-engaging'. */
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
  /** Implant system, e.g. 'Synthetic generic'. */
  system: z.string().min(1),
  /** Platform, e.g. 'RP 4.1'. */
  platform: z.string().min(1),
  /** Engaging (anti-rotation into the implant; single units) or non-engaging (bridges). */
  engaging: z.boolean(),
  /** STL files, relative to the library directory. */
  files: z.object({ scanBody: LibraryPath, tiBase: LibraryPath, screw: LibraryPath.optional() }),
  /** The Ti-base's restoration margin ring (outer edge of the shoulder), CCW seen from +z. */
  shoulderLoop: z.array(Vec3).min(8),
  /** Screw access channel diameter. */
  channelDiameterMm: z.number().positive(),
  /** Largest angled-screw-channel angle from the implant axis. */
  ascMaxDeg: z.number().min(0).max(45),
  /** Height on the implant axis where an angled channel pivots (screw head seat). Default: the Ti-base top. */
  ascPivotZMm: z.number().optional(),
  /** Largest divergence between implant axes in one bridge. */
  maxDivergenceDeg: z.number().min(0).max(90),
  /** Cement gap between the Ti-base and the restoration. */
  bondingGapMm: z.number().min(0).max(0.2),
  /** Height of the scan body, from its top down, that is always above the gingiva (registration region). */
  scanRegionHeightMm: z.number().positive().optional(),
});
export type ImplantLibraryEntryManifest = z.infer<typeof ImplantLibraryEntryManifest>;

export const ImplantLibraryManifest = z
  .object({
    format: z.literal(IMPLANT_LIBRARY_FORMAT),
    formatVersion: z.literal(1),
    /** e.g. 'synthetic-generic@1'. */
    id: z.string().regex(/^[a-z0-9][a-z0-9.-]*@[0-9]+$/),
    name: z.string().min(1),
    /** 'synthetic' for generated libraries; else the vendor's name. */
    vendor: z.string().min(1),
    notice: z.string().optional(),
    units: z.literal('mm'),
    /** The frame every mesh is in (documented constants, checked so a file in another convention is refused). */
    frame: z.object({ origin: z.literal('platform-centre'), axis: z.literal('+z'), antiRotation: z.literal('+x') }),
    entries: z.array(ImplantLibraryEntryManifest).min(1),
  })
  .refine((m) => new Set(m.entries.map((e) => e.id)).size === m.entries.length, { message: 'Entry ids must be unique', path: ['entries'] });
export type ImplantLibraryManifest = z.infer<typeof ImplantLibraryManifest>;

/** A loaded, validated library entry (meshes in the library frame). */
export interface ImplantLibraryEntry {
  /** `${libraryId}/${id}`: what a design stores to name the entry. */
  key: string;
  libraryId: string;
  id: string;
  system: string;
  platform: string;
  engaging: boolean;
  scanBody: IndexedMesh;
  tiBase: IndexedMesh;
  screw?: IndexedMesh;
  /** CCW seen from +z, xyz per point. */
  shoulderLoop: Float32Array;
  channelDiameterMm: number;
  ascMaxDeg: number;
  ascPivotZMm: number;
  maxDivergenceDeg: number;
  bondingGapMm: number;
  scanRegionHeightMm: number;
  /** Derived on load: the scan body's top (largest z). */
  scanBodyTopZ: number;
  /** Derived: largest distance from the axis of the scan body in its scan region. */
  scanBodyRadiusMm: number;
  /** Derived: the Ti-base's top (largest z). */
  tiBaseTopZ: number;
}

export interface ImplantLibrary {
  id: string;
  name: string;
  vendor: string;
  notice?: string;
  entries: ImplantLibraryEntry[];
}

/** The entry with this key (`library@n/entry`) or entry id; throws when it is missing. */
export function implantLibraryEntry(library: ImplantLibrary, keyOrId: string): ImplantLibraryEntry {
  const entry = library.entries.find((e) => e.key === keyOrId || e.id === keyOrId);
  if (!entry) throw new Error(`Implant library ${library.id} has no entry ${keyOrId}`);
  return entry;
}

/** Signed area of a loop projected on the xy plane (positive = CCW seen from +z). */
function signedAreaXY(loop: Float32Array): number {
  const n = loop.length / 3;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += loop[i * 3]! * loop[j * 3 + 1]! - loop[j * 3]! * loop[i * 3 + 1]!;
  }
  return a / 2;
}

function assertClosed(mesh: IndexedMesh, what: string): void {
  const v = validateClosedMesh(mesh);
  if (!v.ok) {
    throw new Error(
      `${what} is not a closed solid (${v.boundaryEdges} boundary, ${v.nonManifoldEdges} non-manifold, ` +
        `${v.inconsistentEdges} inconsistent edges, ${v.degenerateTriangles} degenerate triangles, volume ${v.signedVolumeMm3.toFixed(3)} mm³)`,
    );
  }
}

/**
 * Build a validated entry from meshes already in the library frame (used by
 * the loader and by the synthetic library). Throws when a mesh is not a
 * closed oriented solid, the shoulder loop is not CCW around +z or does not
 * lie on the Ti-base, or a mesh is not centred on the implant axis.
 */
export function makeImplantEntry(
  libraryId: string,
  manifest: Omit<ImplantLibraryEntryManifest, 'files' | 'shoulderLoop'> & { shoulderLoop: Float32Array | V3[] },
  meshes: { scanBody: IndexedMesh; tiBase: IndexedMesh; screw?: IndexedMesh },
): ImplantLibraryEntry {
  const what = `Implant library ${libraryId}, entry ${manifest.id}`;
  assertClosed(meshes.scanBody, `${what}: the scan body`);
  assertClosed(meshes.tiBase, `${what}: the Ti-base`);
  if (meshes.screw) assertClosed(meshes.screw, `${what}: the screw`);
  const shoulderLoop =
    manifest.shoulderLoop instanceof Float32Array ? manifest.shoulderLoop.slice() : Float32Array.from(manifest.shoulderLoop.flat());
  if (!(signedAreaXY(shoulderLoop) > 0)) throw new Error(`${what}: the shoulder loop must run counter-clockwise seen from +z`);

  // The shoulder loop is the restoration margin on the Ti-base: every point must lie on its surface.
  const ray = bvhRayCaster(createBvh({ positions: meshes.tiBase.positions, indices: meshes.tiBase.indices.slice() }));
  let off = 0;
  for (let i = 0; i < shoulderLoop.length / 3; i++) {
    const p: V3 = [shoulderLoop[i * 3]!, shoulderLoop[i * 3 + 1]!, shoulderLoop[i * 3 + 2]!];
    off = Math.max(off, ray.closestPoint(p, 1)?.distance ?? Infinity);
  }
  if (!(off <= SHOULDER_ON_TI_BASE_MM)) throw new Error(`${what}: the shoulder loop is ${off.toFixed(3)} mm off the Ti-base surface`);

  const scanRegionHeightMm = manifest.scanRegionHeightMm ?? DEFAULT_SCAN_REGION_HEIGHT_MM;
  const sb = meshes.scanBody.positions;
  let scanBodyTopZ = -Infinity;
  for (let i = 2; i < sb.length; i += 3) scanBodyTopZ = Math.max(scanBodyTopZ, sb[i]!);
  let scanBodyRadiusMm = 0;
  let cx = 0, cy = 0, count = 0;
  for (let i = 0; i < sb.length; i += 3) {
    if (sb[i + 2]! < scanBodyTopZ - scanRegionHeightMm) continue;
    scanBodyRadiusMm = Math.max(scanBodyRadiusMm, Math.hypot(sb[i]!, sb[i + 1]!));
    cx += sb[i]!;
    cy += sb[i + 1]!;
    count++;
  }
  if (!(scanBodyTopZ > 0)) throw new Error(`${what}: the scan body must extend along +z from the platform`);
  // A scan body with a flat is off-centre by a fraction of its radius; a frame error is millimetres.
  if (Math.hypot(cx / count, cy / count) > 0.5 * scanBodyRadiusMm) throw new Error(`${what}: the scan body is not centred on the implant axis (z)`);
  let tiBaseTopZ = -Infinity;
  for (let i = 2; i < meshes.tiBase.positions.length; i += 3) tiBaseTopZ = Math.max(tiBaseTopZ, meshes.tiBase.positions[i]!);

  return {
    key: `${libraryId}/${manifest.id}`,
    libraryId,
    id: manifest.id,
    system: manifest.system,
    platform: manifest.platform,
    engaging: manifest.engaging,
    scanBody: meshes.scanBody,
    tiBase: meshes.tiBase,
    ...(meshes.screw ? { screw: meshes.screw } : {}),
    shoulderLoop,
    channelDiameterMm: manifest.channelDiameterMm,
    ascMaxDeg: manifest.ascMaxDeg,
    ascPivotZMm: manifest.ascPivotZMm ?? tiBaseTopZ,
    maxDivergenceDeg: manifest.maxDivergenceDeg,
    bondingGapMm: manifest.bondingGapMm,
    scanRegionHeightMm,
    scanBodyTopZ,
    scanBodyRadiusMm,
    tiBaseTopZ,
  };
}

/** Binary or ASCII STL bytes → welded indexed mesh. */
function meshFromStl(bytes: Uint8Array): IndexedMesh {
  return weldSoup(parseStl(bytes));
}

/**
 * Load a library from in-memory buffers: the manifest (JSON text, bytes or
 * an already parsed object) plus every file it references, keyed by its
 * relative path. Validates the manifest with zod and every mesh (closed,
 * oriented, positive volume). Works in the browser, the worker and Node.
 */
export function implantLibraryFromBuffers(manifest: unknown, files: Record<string, Uint8Array> | Map<string, Uint8Array>): ImplantLibrary {
  const raw = typeof manifest === 'string' ? JSON.parse(manifest) : manifest instanceof Uint8Array ? JSON.parse(new TextDecoder().decode(manifest)) : manifest;
  const parsed = ImplantLibraryManifest.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid implant library manifest: ${z.prettifyError(parsed.error)}`);
  const m = parsed.data;
  const get = (path: string): Uint8Array => {
    const bytes = files instanceof Map ? files.get(path) : files[path];
    if (!bytes) throw new Error(`Implant library ${m.id}: missing file ${path}`);
    return bytes;
  };
  const entries = m.entries.map((e) => {
    const { files: paths, ...rest } = e;
    return makeImplantEntry(m.id, rest, {
      scanBody: meshFromStl(get(paths.scanBody)),
      tiBase: meshFromStl(get(paths.tiBase)),
      ...(paths.screw ? { screw: meshFromStl(get(paths.screw)) } : {}),
    });
  });
  return { id: m.id, name: m.name, vendor: m.vendor, ...(m.notice ? { notice: m.notice } : {}), entries };
}

/**
 * Load a library through a file reader (relative path → bytes): the Node
 * directory loader (implantLibraryNode.ts) and, later, a fetch-based browser
 * loader both go through here.
 */
export async function loadImplantLibrary(read: (path: string) => Promise<Uint8Array>): Promise<ImplantLibrary> {
  const manifestBytes = await read(IMPLANT_LIBRARY_MANIFEST);
  const raw: unknown = JSON.parse(new TextDecoder().decode(manifestBytes));
  const parsed = ImplantLibraryManifest.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid implant library manifest: ${z.prettifyError(parsed.error)}`);
  const paths = new Set<string>();
  for (const e of parsed.data.entries) for (const p of Object.values(e.files)) if (p) paths.add(p);
  const files = new Map<string, Uint8Array>();
  for (const p of paths) files.set(p, await read(p));
  return implantLibraryFromBuffers(parsed.data, files);
}

/** The manifest and STL files of a library, keyed by relative path (what the loaders read back). */
export function implantLibraryFiles(library: ImplantLibrary): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const round = (x: number) => Math.round(x * 1e6) / 1e6;
  const entries: ImplantLibraryEntryManifest[] = library.entries.map((e) => {
    const paths = { scanBody: `${e.id}.scan-body.stl`, tiBase: `${e.id}.ti-base.stl`, ...(e.screw ? { screw: `${e.id}.screw.stl` } : {}) };
    files[paths.scanBody] = writeBinaryStl(e.scanBody, `${library.id} ${e.id} scan body`);
    files[paths.tiBase] = writeBinaryStl(e.tiBase, `${library.id} ${e.id} Ti-base`);
    if (e.screw && paths.screw) files[paths.screw] = writeBinaryStl(e.screw, `${library.id} ${e.id} screw`);
    const loop: V3[] = [];
    for (let i = 0; i < e.shoulderLoop.length / 3; i++) loop.push([round(e.shoulderLoop[i * 3]!), round(e.shoulderLoop[i * 3 + 1]!), round(e.shoulderLoop[i * 3 + 2]!)]);
    return {
      id: e.id,
      system: e.system,
      platform: e.platform,
      engaging: e.engaging,
      files: paths,
      shoulderLoop: loop,
      channelDiameterMm: e.channelDiameterMm,
      ascMaxDeg: e.ascMaxDeg,
      ascPivotZMm: e.ascPivotZMm,
      maxDivergenceDeg: e.maxDivergenceDeg,
      bondingGapMm: e.bondingGapMm,
      scanRegionHeightMm: e.scanRegionHeightMm,
    };
  });
  const manifest: ImplantLibraryManifest = {
    format: IMPLANT_LIBRARY_FORMAT,
    formatVersion: 1,
    id: library.id,
    name: library.name,
    vendor: library.vendor,
    ...(library.notice ? { notice: library.notice } : {}),
    units: 'mm',
    frame: { origin: 'platform-centre', axis: '+z', antiRotation: '+x' },
    entries,
  };
  files[IMPLANT_LIBRARY_MANIFEST] = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  return files;
}

// ---------------------------------------------------------------------------
// Implant poses: the library frame placed in the scan.

/**
 * Where an implant (its library frame) sits in the scan: the platform centre,
 * the implant axis (library +z, pointing coronally) and the anti-rotation
 * direction (library +x, ⊥ axis). A rigid transform, no scale.
 */
export interface ImplantPose {
  origin: V3;
  axis: V3;
  xAxis: V3;
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Orthonormal right-handed basis (x, y, z) of a pose; x is re-orthogonalized against the axis. */
export function implantBasis(pose: ImplantPose): { x: V3; y: V3; z: V3 } {
  const zAxis = normalize(pose.axis);
  const d = dot(pose.xAxis, zAxis);
  const x = normalize([pose.xAxis[0] - d * zAxis[0], pose.xAxis[1] - d * zAxis[1], pose.xAxis[2] - d * zAxis[2]]);
  return { x, y: cross(zAxis, x), z: zAxis };
}

/** Library frame → scan. */
export function implantToWorld(pose: ImplantPose): (p: V3) => V3 {
  const { x, y, z: zAxis } = implantBasis(pose);
  const o = pose.origin;
  return (p) => [
    o[0] + p[0] * x[0] + p[1] * y[0] + p[2] * zAxis[0],
    o[1] + p[0] * x[1] + p[1] * y[1] + p[2] * zAxis[1],
    o[2] + p[0] * x[2] + p[1] * y[2] + p[2] * zAxis[2],
  ];
}

/** Scan → library frame. */
export function worldToImplant(pose: ImplantPose): (p: V3) => V3 {
  const { x, y, z: zAxis } = implantBasis(pose);
  const o = pose.origin;
  return (p) => {
    const d: V3 = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
    return [dot(d, x), dot(d, y), dot(d, zAxis)];
  };
}

/** A library mesh (or point list, xyz per point) placed at a pose. */
export function placeAtImplantPose<T extends { positions: Float32Array }>(mesh: T, pose: ImplantPose): T {
  const f = implantToWorld(pose);
  const out = new Float32Array(mesh.positions.length);
  for (let i = 0; i < out.length; i += 3) out.set(f([mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!]), i);
  return { ...mesh, positions: out };
}

/** As the document's Pose (position, unit quaternion, scale 1), e.g. for ToothDesign.implant.scanBodyPose. */
export function implantPoseToPose(pose: ImplantPose): Pose {
  const { x, y, z: zAxis } = implantBasis(pose);
  const q = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(new Vector3(...x), new Vector3(...y), new Vector3(...zAxis)));
  return { position: [...pose.origin], quaternion: [q.x, q.y, q.z, q.w], scale: [1, 1, 1] };
}

/** From the document's Pose (scale ignored). */
export function implantPoseFromPose(pose: Pose): ImplantPose {
  const q = new Quaternion(...pose.quaternion).normalize();
  const x = new Vector3(1, 0, 0).applyQuaternion(q);
  const zAxis = new Vector3(0, 0, 1).applyQuaternion(q);
  return { origin: [...pose.position], axis: [zAxis.x, zAxis.y, zAxis.z], xAxis: [x.x, x.y, x.z] };
}

/**
 * Differences between two poses (e.g. a registration against the truth):
 * platform position (mm), axis angle (°), and the rotation about the axis
 * (°, signed, the x axes compared in the plane ⊥ b's axis).
 */
export function compareImplantPoses(a: ImplantPose, b: ImplantPose): { positionMm: number; axisDeg: number; rotationDeg: number } {
  const ba = implantBasis(a);
  const bb = implantBasis(b);
  const positionMm = Math.hypot(a.origin[0] - b.origin[0], a.origin[1] - b.origin[1], a.origin[2] - b.origin[2]);
  const axisDeg = (Math.acos(Math.min(1, Math.max(-1, dot(ba.z, bb.z)))) * 180) / Math.PI;
  const rotationDeg = (Math.atan2(dot(ba.x, bb.y), dot(ba.x, bb.x)) * 180) / Math.PI;
  return { positionMm, axisDeg, rotationDeg };
}

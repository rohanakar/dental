import { compactVertices, type IndexedMesh } from './mesh';
import { unionMeshes } from './meshBoolean';
import { boundaryLoops, validateClosedMesh } from './meshValidate';
import type { V3 } from './pca';
import { bvhRayCaster, createBvh } from './raycast';
import { syntheticArch, syntheticPrepMargin, syntheticPrepSeed, syntheticTooth, type ArchOptions } from './synthetic';
import { implantToWorld, makeImplantEntry, placeAtImplantPose, type ImplantLibrary, type ImplantPose } from './implantLibrary';

/**
 * Synthetic generic implant library and synthetic scans with scan bodies
 * (no vendor geometry, no patient data). Every part is a closed solid of
 * revolution around +z in the library frame (platform centre at 0, implant
 * axis +z), optionally with an anti-rotation flat facing +x.
 *
 * - Scan body: a 9 mm cylinder (Ø 4) on the platform with a flat 0.5 mm deep
 *   at +x from the platform up to 8 mm, and a round top with a rounded edge.
 * - Ti-base: a connection into the implant, a 0.8 mm gingival collar (Ø 4.2)
 *   whose top is the shoulder (the restoration margin ring is its outer
 *   edge), and a bonding cylinder (Ø 3.5) up to 5 mm. The engaging version has
 *   a flat on the bonding cylinder and on the connection; the non-engaging
 *   one is round. No screw hole: the screw channel is cut from the
 *   restoration (phase B).
 * - Screw: a shaft and a head (display only).
 */

/** Profile point (r, z) of a solid of revolution; `flat` = the cross-section is a "D": x ≤ flat·r. */
interface ProfilePoint {
  r: number;
  z: number;
  flat?: number;
  /** Round this corner with an arc of this radius (mm). */
  fillet?: number;
}

interface Ring {
  r: number;
  z: number;
  flat?: number;
}

/**
 * Expand fillets into arcs and subdivide so consecutive rings are at most
 * `maxStep` apart. The first and last points must lie on the axis (r = 0).
 * A subdivided point takes the cross-section (`flat`) of the segment's end.
 */
function expandProfile(points: ProfilePoint[], maxStep: number): Ring[] {
  const out: Ring[] = [];
  const push = (r: number, z: number, flat?: number) => out.push(flat === undefined ? { r, z } : { r, z, flat });
  const line = (a: [number, number], b: [number, number], flat?: number) => {
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / maxStep));
    for (let k = 1; k < n; k++) push(a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n, flat);
    push(b[0], b[1], flat);
  };
  push(points[0]!.r, points[0]!.z, points[0]!.flat);
  let cursor: [number, number] = [points[0]!.r, points[0]!.z];
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    const next = points[i + 1];
    if (!p.fillet || !next) {
      line(cursor, [p.r, p.z], p.flat);
      cursor = [p.r, p.z];
      continue;
    }
    // Arc tangent to (cursor → p) and (p → next).
    const d1x = p.r - cursor[0], d1z = p.z - cursor[1];
    const l1 = Math.hypot(d1x, d1z);
    const d2x = next.r - p.r, d2z = next.z - p.z;
    const l2 = Math.hypot(d2x, d2z);
    const u1: [number, number] = [d1x / l1, d1z / l1];
    const u2: [number, number] = [d2x / l2, d2z / l2];
    const turn = Math.acos(Math.min(1, Math.max(-1, u1[0] * u2[0] + u1[1] * u2[1])));
    const side = Math.sign(u1[0] * u2[1] - u1[1] * u2[0]);
    const radius = Math.min(p.fillet, (0.45 * Math.min(l1, l2)) / Math.tan(turn / 2));
    const t = radius * Math.tan(turn / 2);
    const start: [number, number] = [p.r - u1[0] * t, p.z - u1[1] * t];
    line(cursor, start, p.flat);
    // Centre on the inner side of the turn.
    const c: [number, number] = [start[0] - side * u1[1] * radius, start[1] + side * u1[0] * radius];
    const a0 = Math.atan2(start[1] - c[1], start[0] - c[0]);
    const n = Math.max(4, Math.ceil((turn * radius) / maxStep));
    for (let k = 1; k <= n; k++) {
      const a = a0 + (side * turn * k) / n;
      push(c[0] + radius * Math.cos(a), c[1] + radius * Math.sin(a), p.flat);
    }
    cursor = [out[out.length - 1]!.r, out[out.length - 1]!.z];
  }
  return out;
}

/**
 * Closed solid of revolution around +z from a profile running from the bottom
 * pole up to the top pole (CCW rings, outward faces). `phaseDeg` rotates the
 * angular sampling (a different tessellation of the same shape).
 */
function lathe(profile: ProfilePoint[], opts: { segments: number; maxStep: number; phaseDeg?: number }): IndexedMesh {
  const rings = expandProfile(profile, opts.maxStep);
  if (rings[0]!.r !== 0 || rings[rings.length - 1]!.r !== 0) throw new Error('A lathe profile starts and ends on the axis');
  // Angles: uniform, plus the exact corners of every flat (so a flat's edges are not chamfered).
  const phase = ((opts.phaseDeg ?? 0) * Math.PI) / 180;
  const corners = new Set<number>();
  for (const r of rings) if (r.flat !== undefined) corners.add(r.flat);
  const twoPi = 2 * Math.PI;
  const angles: number[] = [];
  for (let j = 0; j < opts.segments; j++) angles.push((((phase + (twoPi * j) / opts.segments) % twoPi) + twoPi) % twoPi);
  const exact: number[] = [];
  for (const f of corners) exact.push(Math.acos(f), twoPi - Math.acos(f));
  const minGap = (0.25 * twoPi) / opts.segments;
  const kept = angles.filter((a) => exact.every((e) => Math.min(Math.abs(a - e), twoPi - Math.abs(a - e)) > minGap));
  const phis = [...kept, ...exact].sort((a, b) => a - b);
  const S = phis.length;

  const positions: number[] = [];
  const ringStart: number[] = [];
  for (const ring of rings) {
    ringStart.push(positions.length / 3);
    if (ring.r === 0) {
      positions.push(0, 0, ring.z);
      continue;
    }
    for (const phi of phis) {
      const c = Math.cos(phi);
      const rho = ring.flat !== undefined && c > ring.flat ? (ring.r * ring.flat) / c : ring.r;
      positions.push(rho * c, rho * Math.sin(phi), ring.z);
    }
  }
  const indices: number[] = [];
  const last = rings.length - 1;
  for (let k = 0; k < last; k++) {
    const a0 = ringStart[k]!, b0 = ringStart[k + 1]!;
    for (let j = 0; j < S; j++) {
      const j1 = (j + 1) % S;
      if (k === 0) indices.push(a0, b0 + j1, b0 + j);
      else if (k + 1 === last) indices.push(b0, a0 + j, a0 + j1);
      else indices.push(a0 + j, a0 + j1, b0 + j1, a0 + j, b0 + j1, b0 + j);
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** Synthetic scan body dimensions (mm, library frame). */
export const SYNTHETIC_SCAN_BODY = { radiusMm: 2, heightMm: 9, flatFraction: 0.75, flatTopZ: 8, topFilletMm: 0.4, scanRegionHeightMm: 5 } as const;
/** Synthetic Ti-base dimensions (mm, library frame). */
export const SYNTHETIC_TI_BASE = {
  collarRadiusMm: 2.1,
  shoulderZ: 0.8,
  cylinderRadiusMm: 1.75,
  topZ: 5,
  /** Flat of the engaging bonding cylinder, as a fraction of its radius. */
  flatFraction: 0.85,
  shoulderPoints: 128,
} as const;

export interface LatheOptions {
  /** Angular segments (default 128). */
  segments?: number;
  /** Largest profile step in mm (default 0.2). */
  maxStepMm?: number;
  /** Rotation of the angular sampling (default 0). */
  phaseDeg?: number;
}

const latheOpts = (o: LatheOptions) => ({ segments: o.segments ?? 128, maxStep: o.maxStepMm ?? 0.2, phaseDeg: o.phaseDeg ?? 0 });

/** Synthetic scan body: a cylinder with a flat facing +x and a round, rounded-off top (library frame). */
export function syntheticScanBody(options: LatheOptions = {}): IndexedMesh {
  const { radiusMm: R, heightMm: H, flatFraction: f, topFilletMm, flatTopZ } = SYNTHETIC_SCAN_BODY;
  return lathe(
    [
      { r: 0, z: -1.5 },
      { r: 1.2, z: -1.5, fillet: 0.2 },
      { r: 1.2, z: 0 },
      // The platform seat stays round (a D ring at the same height would fold back over it); the flat runs up the
      // wall and ends below the rounded top, so the top is a full circle centred on the axis.
      { r: R, z: 0 },
      { r: R, z: flatTopZ, flat: f },
      { r: R, z: flatTopZ + 0.2 },
      { r: R, z: H, fillet: topFilletMm },
      { r: 0, z: H },
    ],
    latheOpts(options),
  );
}

/** Synthetic Ti-base (library frame): engaging = flats on the bonding cylinder and the connection. */
export function syntheticTiBase(options: LatheOptions & { engaging: boolean }): IndexedMesh {
  const t = SYNTHETIC_TI_BASE;
  const f = options.engaging ? t.flatFraction : undefined;
  return lathe(
    [
      { r: 0, z: -1.6, flat: f },
      { r: 1.2, z: -1.6, flat: f, fillet: 0.2 },
      { r: 1.2, z: 0, flat: f },
      { r: t.collarRadiusMm, z: 0 },
      { r: t.collarRadiusMm, z: t.shoulderZ },
      { r: t.cylinderRadiusMm, z: t.shoulderZ, flat: f, fillet: 0.15 },
      { r: t.cylinderRadiusMm, z: t.topZ, flat: f, fillet: 0.3 },
      { r: 0, z: t.topZ, flat: f },
    ],
    latheOpts(options),
  );
}

/** Synthetic prosthetic screw (display only): shaft Ø 1.6, head Ø 2.0 seated at 1.5–2.2 mm. */
export function syntheticScrew(options: LatheOptions = {}): IndexedMesh {
  return lathe(
    [
      { r: 0, z: -7 },
      { r: 0.8, z: -7, fillet: 0.2 },
      { r: 0.8, z: 1.5 },
      { r: 1.0, z: 1.5 },
      { r: 1.0, z: 2.2, fillet: 0.2 },
      { r: 0, z: 2.2 },
    ],
    { segments: options.segments ?? 64, maxStep: options.maxStepMm ?? 0.4, phaseDeg: options.phaseDeg ?? 0 },
  );
}

/** The synthetic Ti-base's restoration margin: the outer edge of the shoulder, CCW seen from +z. */
export function syntheticShoulderLoop(points: number = SYNTHETIC_TI_BASE.shoulderPoints): Float32Array {
  const t = SYNTHETIC_TI_BASE;
  const out = new Float32Array(points * 3);
  for (let j = 0; j < points; j++) {
    const phi = (2 * Math.PI * j) / points;
    out.set([t.collarRadiusMm * Math.cos(phi), t.collarRadiusMm * Math.sin(phi), t.shoulderZ], j * 3);
  }
  return out;
}

export const SYNTHETIC_IMPLANT_LIBRARY_ID = 'synthetic-generic@1';

/**
 * The synthetic generic library: one platform with an engaging (single
 * units) and a non-engaging (bridges) Ti-base, sharing one scan body.
 * Placeholder clinical values: channel Ø 2.2 mm, ASC up to 25°, divergence
 * up to 20°, bonding gap 0.03 mm.
 */
export function syntheticImplantLibrary(): ImplantLibrary {
  const scanBody = syntheticScanBody();
  const screw = syntheticScrew();
  const shoulderLoop = syntheticShoulderLoop();
  const common = {
    system: 'Synthetic generic',
    platform: 'RP 4.1',
    channelDiameterMm: 2.2,
    ascMaxDeg: 25,
    ascPivotZMm: 1.85,
    maxDivergenceDeg: 20,
    bondingGapMm: 0.03,
    scanRegionHeightMm: SYNTHETIC_SCAN_BODY.scanRegionHeightMm,
    shoulderLoop,
  };
  return {
    id: SYNTHETIC_IMPLANT_LIBRARY_ID,
    name: 'Synthetic generic implant library',
    vendor: 'synthetic',
    notice: 'Generated by tools/fixtures/implant-library.mts. Synthetic geometry for development and tests: not a vendor library, not for clinical use.',
    entries: [
      makeImplantEntry(SYNTHETIC_IMPLANT_LIBRARY_ID, { ...common, id: 'rp-engaging', engaging: true }, { scanBody, tiBase: syntheticTiBase({ engaging: true }), screw }),
      makeImplantEntry(SYNTHETIC_IMPLANT_LIBRARY_ID, { ...common, id: 'rp-non-engaging', engaging: false }, { scanBody, tiBase: syntheticTiBase({ engaging: false }), screw }),
    ],
  };
}

// ---------------------------------------------------------------------------
// Synthetic scans with scan bodies.

export interface SyntheticScanBodyPlacement {
  fdi: number;
  /** Tilt of the implant axis toward mesial in degrees (negative = distal). */
  mesialTiltDeg?: number;
  /** Tilt toward buccal in degrees (negative = lingual). */
  buccalTiltDeg?: number;
  /** The flat's direction about the axis: degrees from buccal, CCW seen from the occlusal side. */
  rotationDeg?: number;
  /** Platform depth below the ridge crest, along the axis (default 2.5 mm). */
  depthMm?: number;
  /** Shift of the implant along the arch from the site's centre, toward mesial (negative = distal), mm. */
  mesialOffsetMm?: number;
}

export interface SyntheticImplantScanOptions extends Pick<ArchOptions, 'jaw' | 'along' | 'across' | 'preps' | 'missing'> {
  scanBodies: SyntheticScanBodyPlacement[];
  /**
   * The scan body in the library frame. Default: the synthetic scan body
   * tessellated differently from the library's (90 segments, 0.25 mm steps,
   * rotated sampling), so a registration cannot match vertices one to one.
   */
  scanBody?: IndexedMesh;
  /** Gaussian noise (σ per coordinate, mm) added to every vertex; default 0. */
  noiseMm?: number;
  seed?: number;
}

export interface SyntheticImplantScan {
  /** One merged scan surface: the jaw with the scan bodies standing out of the gingiva. */
  mesh: IndexedMesh;
  /** The true poses, in placement order; `topCentre` is where a user would click. */
  implants: Array<{ fdi: number; pose: ImplantPose; topCentre: V3 }>;
}

/** σ of the synthetic scan body's surface texture (mm). */
const TEXTURE_MM = 0.001;

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const horizontal = (a: V3): V3 => normalize([a[0], a[1], 0]);

/**
 * Close an open height-field surface (one boundary loop) into a solid: a
 * flat floor `depth` mm beyond its lowest point (away from occlusal) and
 * vertical walls along the boundary.
 */
function closeHeightField(mesh: IndexedMesh, occlusalSign: 1 | -1, depth: number): { solid: IndexedMesh; floorZ: number; surfaceExtremeZ: number } {
  const loops = boundaryLoops(mesh);
  if (loops.length !== 1) throw new Error(`Expected one boundary loop, found ${loops.length}`);
  const nv = mesh.positions.length / 3;
  let extreme = occlusalSign > 0 ? Infinity : -Infinity;
  for (let i = 2; i < mesh.positions.length; i += 3) extreme = occlusalSign > 0 ? Math.min(extreme, mesh.positions[i]!) : Math.max(extreme, mesh.positions[i]!);
  const floorZ = extreme - occlusalSign * depth;
  const positions = new Float32Array(nv * 6);
  positions.set(mesh.positions);
  for (let v = 0; v < nv; v++) positions.set([mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, floorZ], (nv + v) * 3);
  const loop = loops[0]!;
  const nf = mesh.indices.length / 3;
  const indices = new Uint32Array(nf * 6 + loop.length * 6);
  indices.set(mesh.indices);
  for (let f = 0; f < nf; f++) {
    indices[(nf + f) * 3] = mesh.indices[f * 3]! + nv;
    indices[(nf + f) * 3 + 1] = mesh.indices[f * 3 + 2]! + nv;
    indices[(nf + f) * 3 + 2] = mesh.indices[f * 3 + 1]! + nv;
  }
  let o = nf * 6;
  for (let k = 0; k < loop.length; k++) {
    // Boundary edge a → b runs in its triangle's direction; the wall uses b → a on top and a' → b' on the floor.
    const a = loop[k]!, b = loop[(k + 1) % loop.length]!;
    indices.set([b, a, a + nv, b, a + nv, b + nv], o);
    o += 6;
  }
  let solid: IndexedMesh = { positions, indices };
  if (validateClosedMesh(solid).signedVolumeMm3 < 0) {
    for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2]!, indices[i + 1]!];
    solid = { positions, indices };
  }
  return { solid, floorZ, surfaceExtremeZ: extreme };
}

/** Deterministic standard-normal generator (mulberry32 + Box–Muller). */
function gaussian(seed: number): () => number {
  let s = seed >>> 0;
  const uniform = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
}

/**
 * A synthetic jaw scan with scan bodies: `syntheticArch` with the implant
 * sites missing, plus the scan body standing in each site at a known pose,
 * sunk into the gingiva (the platform `depthMm` below the ridge crest), merged
 * into one surface by a boolean union (the parts inside the gingiva are
 * gone, as in a real scan). The scan body carries a 1 µm surface texture
 * and, by default, a tessellation unlike the library's. Optional Gaussian
 * noise. Requires `await initMeshBoolean()`.
 *
 * Each site's frame comes from the synthetic layout: mesial along the arch
 * toward the midline, buccal outward, occlusal +z (lower) or −z (upper).
 */
export function syntheticImplantScan(options: SyntheticImplantScanOptions): SyntheticImplantScan {
  const jaw = options.jaw ?? 'lower';
  const along = options.along ?? 400;
  const missing = options.missing ?? [];
  for (const sb of options.scanBodies) if (!missing.includes(sb.fdi)) throw new Error(`Tooth ${sb.fdi} must be missing to hold a scan body`);
  const arch = syntheticArch({ jaw, along, across: options.across ?? 120, preps: options.preps ?? [], missing });
  const occlusalSign: 1 | -1 = jaw === 'lower' ? 1 : -1;
  const occlusal: V3 = [0, 0, occlusalSign];
  const ray = bvhRayCaster(createBvh({ positions: arch.positions, indices: arch.indices.slice() }));
  const scanBody = options.scanBody ?? syntheticScanBody({ segments: 90, maxStepMm: 0.25, phaseDeg: 1.3 });
  let topZ = -Infinity;
  for (let i = 2; i < scanBody.positions.length; i += 3) topZ = Math.max(topZ, scanBody.positions[i]!);
  // A 1 µm surface texture: nothing stays exactly coplanar or collinear, so the union's clean-up keeps the scan
  // body's own tessellation instead of merging its planar facets into long strips (as on a real scan).
  const texture = gaussian(0x5ca9b0d1);
  const textured: IndexedMesh = { positions: scanBody.positions.map((x) => x + TEXTURE_MM * texture()), indices: scanBody.indices };

  const implants: SyntheticImplantScan['implants'] = [];
  const solids: IndexedMesh[] = [];
  for (const placement of options.scanBodies) {
    if (syntheticTooth(placement.fdi).jaw !== jaw) throw new Error(`Tooth ${placement.fdi} is not in the ${jaw} jaw`);
    const seed = syntheticPrepSeed({ fdi: placement.fdi, along });
    const ring = syntheticPrepMargin({ fdi: placement.fdi, along, samples: 64 });
    // Sample 0 of the analytic ring is the distal end, sample 16 the buccal one.
    const mesial = horizontal(sub(seed, [ring[0]!, ring[1]!, ring[2]!]));
    const buccalRaw = horizontal(sub([ring[48]!, ring[49]!, ring[50]!], seed));
    const buccal = normalize(sub(buccalRaw, [mesial[0] * dot(buccalRaw, mesial), mesial[1] * dot(buccalRaw, mesial), 0]));
    const shift = placement.mesialOffsetMm ?? 0;
    const above: V3 = [seed[0] + shift * mesial[0] + occlusal[0] * 20, seed[1] + shift * mesial[1] + occlusal[1] * 20, seed[2] + occlusal[2] * 20];
    const crest = ray.first(above, [-occlusal[0], -occlusal[1], -occlusal[2]], 60);
    if (!crest) throw new Error(`No ridge under tooth ${placement.fdi}`);
    const tm = Math.tan(((placement.mesialTiltDeg ?? 0) * Math.PI) / 180);
    const tb = Math.tan(((placement.buccalTiltDeg ?? 0) * Math.PI) / 180);
    const axis = normalize([occlusal[0] + tm * mesial[0] + tb * buccal[0], occlusal[1] + tm * mesial[1] + tb * buccal[1], occlusal[2] + tm * mesial[2] + tb * buccal[2]]);
    const b0 = normalize(sub(buccal, [axis[0] * dot(buccal, axis), axis[1] * dot(buccal, axis), axis[2] * dot(buccal, axis)]));
    const y0 = cross(axis, b0);
    const rot = ((placement.rotationDeg ?? 0) * Math.PI) / 180;
    const xAxis: V3 = [Math.cos(rot) * b0[0] + Math.sin(rot) * y0[0], Math.cos(rot) * b0[1] + Math.sin(rot) * y0[1], Math.cos(rot) * b0[2] + Math.sin(rot) * y0[2]];
    const depth = placement.depthMm ?? 2.5;
    const origin: V3 = [crest.point[0] - depth * axis[0], crest.point[1] - depth * axis[1], crest.point[2] - depth * axis[2]];
    const pose: ImplantPose = { origin, axis, xAxis };
    implants.push({ fdi: placement.fdi, pose, topCentre: implantToWorld(pose)([0, 0, topZ]) });
    solids.push(placeAtImplantPose(textured, pose));
  }

  // Union with the jaw closed into a solid, then drop the floor and the walls again.
  const { solid, surfaceExtremeZ } = closeHeightField(arch, occlusalSign, 4.5);
  const merged = unionMeshes([solid, ...solids]);
  const keep: number[] = [];
  const P = merged.positions;
  const beyond = (v: number) => occlusalSign * (P[v * 3 + 2]! - surfaceExtremeZ) < -0.01;
  for (let f = 0; f < merged.indices.length; f += 3) {
    const a = merged.indices[f]!, b = merged.indices[f + 1]!, c = merged.indices[f + 2]!;
    if (!beyond(a) && !beyond(b) && !beyond(c)) keep.push(a, b, c);
  }
  const mesh = compactVertices({ positions: merged.positions, indices: Uint32Array.from(keep) });

  if (options.noiseMm) {
    const g = gaussian(options.seed ?? 1);
    for (let i = 0; i < mesh.positions.length; i++) mesh.positions[i] = mesh.positions[i]! + options.noiseMm * g();
  }
  return { mesh, implants };
}

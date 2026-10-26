import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveBridges, jawOf, MATERIAL_PRESETS, RESTORATION_ROLE, validateBridges, type CaseSetup, type QaCheck, type UnitKind } from '@dcad/shared';
import {
  analyzeSurface,
  archAlignedFrame,
  archFitDirections,
  BridgeCache,
  bvhRayCaster,
  compareImplantPoses,
  createBvh,
  designBridge,
  estimateToothFrame,
  fitArchCurve,
  gingivalOpening,
  implantLibraryEntry,
  implantPoseToPose,
  implantToothFrame,
  initMeshBoolean,
  processScan,
  proposeScrewChannel,
  registerScanBody,
  searchImplantPath,
  smoothVertexNormals,
  syntheticImplantLibrary,
  writeBinaryStl,
  type BridgeUnitInput,
  type ImplantCrownDesign,
  type ProcessedScan,
  type V3,
} from '@dcad/web/geometry';
import type { GoldenImplantCase } from './implantGolden';
import { round, roundV } from './pipeline';

/** Largest bonding-gap error on a Ti-base (the gap is 0.03 mm; convex edges and blockout boundaries cost up to ~0.02). */
export const MAX_TI_BASE_GAP_ERROR_MM = 0.025;

export interface ImplantUnitMetrics {
  fdi: number;
  kind: UnitKind;
  registration?: {
    rmsMm: number;
    maxMm: number;
    inlierFraction: number;
    coverage: number;
    passed: boolean;
    /** Against the true pose (synthetic cases). */
    errorMm?: number;
    axisErrorDeg?: number;
    rotationErrorDeg?: number;
    ms: number;
  };
  frame: { origin: V3; occlusal: V3; mesial: V3; buccal: V3; mesialContact?: V3; distalContact?: V3 };
  opening?: { meanHeightMm: number; minHeightMm: number; maxHeightMm: number; coverage: number };
  pose: { position: V3; scale: V3 };
  triangles: number;
  watertight: boolean;
  printable: boolean;
  tiBaseGap?: { samples: number; meanErrorMm: number; maxErrorMm: number; minGapMm: number };
  channel?: { angleDeg: number; azimuthDeg: number; source: 'straight' | 'auto'; exitOk: boolean; occlusalDot?: number; minWallMm: number; wallOk: boolean; cut: boolean; cutGenus?: number };
  thickness: { minMm: number };
  warnings: string[];
}

export interface ImplantCaseMetrics {
  id: string;
  kind: 'implant-bridge';
  teeth: number[];
  material: string;
  ok: boolean;
  timingsMs: Record<string, number>;
  path: { direction: V3; divergenceDeg: number; maxDivergenceDeg: number; implants: Array<{ fdi: number; angleToPathDeg: number }> };
  units: ImplantUnitMetrics[];
  connectors: Array<{ between: [number, number]; areaMm2: number; heightMm: number; measuredAreaMm2?: number; measuredHeightMm?: number; failures: string[] }>;
  union?: { triangles: number; volumeMm3: number; closed: boolean; printable: boolean; selfIntersections: number; components: number; genus: number };
  seating: Array<{ fdi: number; samples: number; ownSamples: number; deltaMeanMm: number; deltaMaxMm: number }>;
  ponticBase: Array<{ fdi: number; minGapMm: number; targetMm: number }>;
  /** What CAM and the lab need to match the Ti-bases (as in the export sidecar). */
  sidecar: Array<{ fdi: number; libraryId: string; engaging: boolean; pose: ReturnType<typeof implantPoseToPose>; channel: { pivot: V3; direction: V3; angleDeg: number } }>;
  warnings: string[];
  checks: QaCheck[];
}

/**
 * Run an implant golden case headlessly: import → per implant unit the scan-body registration (from the scripted
 * click), the tooth frame (estimated from the click, aligned to the arch, moved onto the gingival opening) → the
 * common path over the implant axes → designBridge (implant crowns with emergence and screw channels, pontics,
 * connectors, union) → the checks. A single implant crown is a one-unit case without connections.
 */
export async function runImplantBridgeCase(spec: GoldenImplantCase, baseDir: string): Promise<{ metrics: ImplantCaseMetrics; bridgeStl: Uint8Array }> {
  const timings: Record<string, number> = {};
  const time = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
    const t0 = performance.now();
    const out = await fn();
    timings[name] = round(performance.now() - t0, 1);
    return out;
  };
  const setup: CaseSetup = {
    patientRef: spec.id,
    notes: '',
    teeth: spec.units.map((u) => ({ fdi: u.fdi, restoration: u.restoration, material: spec.material })),
    connections: spec.connections,
  };
  const validation = validateBridges(setup);
  if (validation.errors.length) throw new Error(`Case ${spec.id}: ${validation.errors.map((e) => e.message).join('; ')}`);
  const bridges = deriveBridges(setup);
  const teeth = bridges[0]?.teeth ?? spec.units.map((u) => u.fdi);
  const connectors = bridges[0]?.connectors ?? [];
  const kindOf = (fdi: number): UnitKind => RESTORATION_ROLE[spec.units.find((u) => u.fdi === fdi)!.restoration].role;

  const jawRole = jawOf(teeth[0]!);
  const scans: Partial<Record<'upper' | 'lower', ProcessedScan>> = {};
  for (const role of ['upper', 'lower'] as const) {
    const file = spec.scans[role];
    if (file) scans[role] = await time(`import.${role}`, () => processScan(new Uint8Array(readFileSync(join(baseDir, file))), file));
  }
  const prep = scans[jawRole];
  if (!prep) throw new Error(`Case ${spec.id}: the ${jawRole} scan is missing`);
  const { positions, normals } = prep.mesh;
  const indices = prep.mesh.indices;
  const ray = bvhRayCaster(await time('bvh', () => createBvh({ positions, indices })));
  const surface = await time('analyzeSurface', () => analyzeSurface({ positions, indices, normals }));
  const smoothNormals = await time('smoothNormals', () => smoothVertexNormals(normals, surface.graph, 3));
  const antagonist = scans[jawRole === 'lower' ? 'upper' : 'lower'];
  const antagonistRay = antagonist ? bvhRayCaster(createBvh({ positions: antagonist.mesh.positions, indices: antagonist.mesh.indices })) : undefined;
  await time('initBooleans', () => initMeshBoolean());
  const library = syntheticImplantLibrary();
  const params = { ...MATERIAL_PRESETS[spec.material], ...spec.params };

  const checks: QaCheck[] = [];
  const check = (id: string, passed: boolean, message: string, value?: number, threshold?: number) =>
    checks.push({ id, passed, message, ...(value !== undefined ? { value: round(value) } : {}), ...(threshold !== undefined ? { threshold } : {}) });

  // Implant units: registration, then the frame.
  const implantUnits = spec.units.filter((u) => u.restoration === 'implant-crown');
  const registered = await time('registration', () =>
    implantUnits.map((u) => {
      if (!u.click || !u.library) throw new Error(`Case ${spec.id}: implant ${u.fdi} needs a click and a library entry`);
      const entry = implantLibraryEntry(library, u.library);
      const t0 = performance.now();
      const reg = registerScanBody({ positions, indices, click: u.click, entry });
      const ms = performance.now() - t0;
      const error = u.truePose ? compareImplantPoses(reg.pose, u.truePose) : undefined;
      return { u, entry, reg, error, ms };
    }),
  );
  const estimates = registered.map((r) => estimateToothFrame({ jaw: { positions, normals }, seed: r.u.click!, fdi: r.u.fdi, ray }));
  const curve = await time('archCurve', () => fitArchCurve({ positions, ...archFitDirections(estimates.map((e, i) => ({ ...e, fdi: registered[i]!.u.fdi })), positions) }));
  const frames = await time('frames', () =>
    registered.map((r, i) => {
      const aligned = archAlignedFrame({ frame: estimates[i]!, fdi: r.u.fdi, curve, ray });
      const opening = gingivalOpening({ positions, entry: r.entry, pose: r.reg.pose });
      return { fdi: r.u.fdi, opening, frame: implantToothFrame({ frame: aligned.frame, opening, ray }) };
    }),
  );

  // The common path over the implant axes (a single implant: its own axis).
  const path = searchImplantPath(registered.map((r) => ({ fdi: r.u.fdi, axis: r.reg.pose.axis, maxDivergenceDeg: r.entry.maxDivergenceDeg })));
  const contact = { targetMm: params.proximalContactMm };
  const units: BridgeUnitInput[] = teeth.map((fdi) => {
    const r = registered.find((x) => x.u.fdi === fdi);
    const adapt = { occlusion: { clearanceMm: params.occlusalClearanceMm }, mesial: contact, distal: contact };
    if (!r) return { fdi, kind: kindOf(fdi), params, adapt };
    const frame = frames.find((f) => f.fdi === fdi)!.frame;
    return {
      fdi,
      kind: kindOf(fdi),
      params,
      frame,
      implant: { entry: r.entry, pose: r.reg.pose, ...(r.u.channel ? { channel: r.u.channel } : {}) },
      adapt: { occlusion: adapt.occlusion, ...(frame.mesialContact ? { mesial: contact } : {}), ...(frame.distalContact ? { distal: contact } : {}) },
    };
  });
  const cache = new BridgeCache();
  const design = (union: boolean) =>
    designBridge({
      jaw: { positions, indices, graph: surface.graph, smoothNormals, ray },
      antagonist: antagonistRay,
      axis: path.direction,
      units,
      connectors,
      material: spec.material,
      curve,
      maps: ['thickness', 'occlusion'],
      union,
      cache,
    });
  // Screw channels: a straight channel that exits buccally or leaves a thin wall is angled (classical.screw-channel:
  // the smallest ASC angle that passes), as the proposer does in the app; a scripted channel is kept.
  const autoChannels = new Map<number, { angleDeg: number; azimuthDeg: number } | null>();
  await time('channels', () => {
    for (const r of design(false).units) {
      const unit = units.find((x) => x.fdi === r.fdi)!;
      const extras = (r.design as ImplantCrownDesign).implant;
      if (!unit.implant || !extras || spec.units.find((x) => x.fdi === r.fdi)?.channel) continue;
      if (extras.channel.exitOk && extras.channel.wallOk) continue;
      const found = proposeScrewChannel({ mesh: r.design.mesh, unit: unit.implant, fdi: r.fdi, frame: r.frame, wallMm: params.channelWallMm });
      autoChannels.set(r.fdi, found ? { angleDeg: found.angleDeg, azimuthDeg: found.azimuthDeg } : null);
      if (found) unit.implant = { ...unit.implant, channel: { angleDeg: found.angleDeg, azimuthDeg: found.azimuthDeg } };
    }
  });
  const result = await time('designBridge', () => design(true));
  for (const [k, v] of Object.entries(result.timingsMs)) timings[`designBridge.${k}`] = round(v, 1);
  if (!result.union) throw new Error(`Case ${spec.id}: ${result.unionError ?? 'no union'}`);
  const union = result.union;
  const bridgeStl = writeBinaryStl(union.mesh);

  // Checks.
  for (const r of registered) {
    check(`registration.gate.${r.u.fdi}`, r.reg.passed, `${r.u.fdi}: the scan-body match passes its gate (${r.reg.failures.join('; ') || 'RMS, inliers and coverage'})`);
    check(`registration.rms.${r.u.fdi}`, r.reg.rmsMm <= spec.expect.maxFitRmsMm, `${r.u.fdi}: scan-body fit RMS (mm)`, r.reg.rmsMm, spec.expect.maxFitRmsMm);
    if (r.error) {
      check(`registration.position.${r.u.fdi}`, r.error.positionMm <= spec.expect.maxRegistrationErrorMm, `${r.u.fdi}: platform position error against the truth (mm)`, r.error.positionMm, spec.expect.maxRegistrationErrorMm);
      check(`registration.axis.${r.u.fdi}`, r.error.axisDeg <= spec.expect.maxRegistrationAngleDeg, `${r.u.fdi}: implant axis error against the truth (°)`, r.error.axisDeg, spec.expect.maxRegistrationAngleDeg);
    }
  }
  check('path.divergence', path.ok, `Largest divergence between the implant axes, within the library's ${path.maxDivergenceDeg}° (°)`, path.divergenceDeg, path.maxDivergenceDeg);
  if (spec.expect.divergenceDeg !== undefined) {
    const off = Math.abs(path.divergenceDeg - spec.expect.divergenceDeg);
    check('path.divergenceExpected', off <= spec.expect.divergenceToleranceDeg, `Measured divergence against the true ${spec.expect.divergenceDeg}° (difference, °)`, off, spec.expect.divergenceToleranceDeg);
  }

  const unitMetrics: ImplantUnitMetrics[] = result.units.map((r) => {
    const d = r.design as ImplantCrownDesign;
    const reg = registered.find((x) => x.u.fdi === r.fdi);
    check(`unit.watertight.${r.fdi}`, d.validation.ok, `${r.fdi}: closed, consistently oriented solid with positive volume`);
    check(`unit.printable.${r.fdi}`, Boolean(d.validation.printable), `${r.fdi}: no self-intersections`, d.validation.selfIntersections, 0);
    const extras = d.implant;
    if (extras) {
      check(`tiBase.seatable.${r.fdi}`, extras.rimUndercutCount === 0, `${r.fdi}: no shoulder point hidden under the Ti-base from the insertion path`, extras.rimUndercutCount, 0);
      check(`tiBase.gap.${r.fdi}`, extras.tiBaseGap.tiBaseSamples > 0 && extras.tiBaseGap.maxErrorMm <= MAX_TI_BASE_GAP_ERROR_MM && extras.tiBaseGap.intaglioMinGapMm > 0, `${r.fdi}: bonding-gap error on the Ti-base, no penetration (mm)`, extras.tiBaseGap.maxErrorMm, MAX_TI_BASE_GAP_ERROR_MM);
      check(`channel.exit.${r.fdi}`, extras.channel.exitOk, `${r.fdi}: the screw channel exits occlusally (outer normal · occlusal)`, extras.channel.exit?.occlusalDot ?? -1, 0.5);
      check(`channel.wall.${r.fdi}`, extras.channel.wallOk, `${r.fdi}: material around the screw channel (mm)`, extras.channel.minWallMm, extras.channel.requiredWallMm);
      check(`channel.cut.${r.fdi}`, Boolean(extras.cutCheck?.ok), `${r.fdi}: the restoration with its channel is one closed solid with one through-hole`);
      check(`unit.thickness.${r.fdi}`, d.thickness.minMm >= params.minThicknessMm - 0.02, `${r.fdi}: minimum material thickness away from the shoulder (mm)`, d.thickness.minMm, round(params.minThicknessMm - 0.02));
    }
    const f = r.frame;
    return {
      fdi: r.fdi,
      kind: r.kind,
      ...(reg
        ? {
            registration: {
              rmsMm: round(reg.reg.rmsMm, 5),
              maxMm: round(reg.reg.maxMm, 5),
              inlierFraction: round(reg.reg.inlierFraction),
              coverage: round(reg.reg.coverage),
              passed: reg.reg.passed,
              ...(reg.error ? { errorMm: round(reg.error.positionMm, 5), axisErrorDeg: round(reg.error.axisDeg, 4), rotationErrorDeg: round(reg.error.rotationDeg, 4) } : {}),
              ms: round(reg.ms, 1),
            },
          }
        : {}),
      frame: {
        origin: roundV(f.origin),
        occlusal: roundV(f.occlusal),
        mesial: roundV(f.mesial),
        buccal: roundV(f.buccal),
        ...(f.mesialContact ? { mesialContact: roundV(f.mesialContact) } : {}),
        ...(f.distalContact ? { distalContact: roundV(f.distalContact) } : {}),
      },
      ...(extras ? { opening: { meanHeightMm: round(extras.opening.meanHeightMm), minHeightMm: round(extras.opening.minHeightMm), maxHeightMm: round(extras.opening.maxHeightMm), coverage: round(extras.opening.coverage) } } : {}),
      pose: { position: roundV(d.pose.position), scale: roundV(d.pose.scale) },
      triangles: d.validation.triangles,
      watertight: d.validation.ok,
      printable: Boolean(d.validation.printable),
      ...(extras
        ? {
            tiBaseGap: { samples: extras.tiBaseGap.tiBaseSamples, meanErrorMm: round(extras.tiBaseGap.meanErrorMm, 5), maxErrorMm: round(extras.tiBaseGap.maxErrorMm, 5), minGapMm: round(extras.tiBaseGap.intaglioMinGapMm, 5) },
            channel: {
              angleDeg: extras.channel.angleDeg,
              azimuthDeg: extras.channel.azimuthDeg,
              source: autoChannels.has(r.fdi) ? ('auto' as const) : ('straight' as const),
              exitOk: extras.channel.exitOk,
              ...(extras.channel.exit ? { occlusalDot: round(extras.channel.exit.occlusalDot) } : {}),
              minWallMm: round(extras.channel.minWallMm),
              wallOk: extras.channel.wallOk,
              cut: Boolean(extras.cut),
              ...(extras.cutCheck ? { cutGenus: extras.cutCheck.genus } : {}),
            },
          }
        : {}),
      thickness: { minMm: round(d.thickness.minMm) },
      warnings: d.warnings,
    };
  });

  const u = union.checks.union;
  const channels = unitMetrics.filter((m) => m.channel?.cut).length;
  check('union.watertight', u.closed && u.oriented && u.degenerateTriangles === 0, 'The merged bridge is a closed, consistently oriented solid');
  check('union.printable', u.printable, 'The merged bridge has no self-intersections', u.selfIntersections, 0);
  check('union.oneSolid', u.components === 1 && u.genus === channels, `The merged bridge is one solid with one through-hole per screw channel (${channels})`, u.genus, channels);
  for (const c of union.checks.connectors) {
    const label = `${c.between[0]}-${c.between[1]}`;
    check(`connector.area.${label}`, c.areaOk, `Connector ${label}: smallest measured section ≥ the designed area (mm²)`, c.measured.minAreaMm2, c.targetAreaMm2);
    check(`connector.height.${label}`, c.heightOk, `Connector ${label}: height ≥ the minimum (mm)`, Math.min(c.measured.heightMm, c.designedHeightMm), c.minHeightMm);
    check(`connector.design.${label}`, c.failures.length === 0, c.failures.length ? c.failures.map((f) => f.message).join(' ') : `Connector ${label}: fits the embrasures and the units`);
  }
  for (const s of union.checks.seating) {
    check(`seating.${s.fdi}`, s.ok, `Implant crown ${s.fdi}: seating on its Ti-base unchanged in the union (max change, mm)`, Math.max(s.deltaMeanMm, s.deltaMaxMm), 0.005);
  }
  for (const p of union.checks.ponticBase) {
    check(`ponticBase.${p.fdi}`, p.ok, `Pontic ${p.fdi}: smallest base gap to the ridge, within the target −0.02/+0.05 mm (mm)`, p.minGapMm, round(p.targetMm - 0.02));
  }

  const metrics: ImplantCaseMetrics = {
    id: spec.id,
    kind: 'implant-bridge',
    teeth,
    material: spec.material,
    ok: checks.every((c) => c.passed),
    timingsMs: timings,
    path: { direction: roundV(path.direction), divergenceDeg: round(path.divergenceDeg, 3), maxDivergenceDeg: path.maxDivergenceDeg, implants: path.implants.map((i) => ({ fdi: i.fdi, angleToPathDeg: round(i.angleToPathDeg, 3) })) },
    units: unitMetrics,
    connectors: result.connectors.map((c) => {
      const m = union.checks.connectors.find((x) => x.between[0] === c.between[0] && x.between[1] === c.between[1])?.measured;
      return {
        between: c.between,
        areaMm2: c.areaMm2,
        heightMm: round(c.heightMm),
        ...(m ? { measuredAreaMm2: round(m.minAreaMm2), measuredHeightMm: round(m.heightMm) } : {}),
        failures: c.failures.map((f) => f.message),
      };
    }),
    union: { triangles: u.triangles, volumeMm3: round(u.volumeMm3, 2), closed: u.closed, printable: u.printable, selfIntersections: u.selfIntersections, components: u.components, genus: u.genus },
    seating: union.checks.seating.map((s) => ({ fdi: s.fdi, samples: s.onUnion.samples, ownSamples: s.own.samples, deltaMeanMm: round(s.deltaMeanMm, 6), deltaMaxMm: round(s.deltaMaxMm, 6) })),
    ponticBase: union.checks.ponticBase.map((p) => ({ fdi: p.fdi, minGapMm: round(p.minGapMm, 5), targetMm: p.targetMm })),
    sidecar: result.units.flatMap((r) => {
      const unit = units.find((x) => x.fdi === r.fdi)!;
      const extras = (r.design as ImplantCrownDesign).implant;
      if (!unit.implant || !extras) return [];
      return [{ fdi: r.fdi, libraryId: extras.libraryId, engaging: extras.engaging, pose: implantPoseToPose(unit.implant.pose), channel: { pivot: roundV(extras.channel.pivot), direction: roundV(extras.channel.direction), angleDeg: extras.channel.angleDeg } }];
    }),
    warnings: result.warnings,
    checks,
  };
  return { metrics, bridgeStl };
}

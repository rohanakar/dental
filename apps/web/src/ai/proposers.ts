import {
  bridgeOf,
  type BridgeDesign,
  type Command,
  connectedSides,
  type CrownAdapt,
  type Cutback,
  type DesignDocument,
  isPosterior,
  jawOf,
  type Material,
  type ProposalResult,
  type ProposerId,
  type ProximalSide,
  type QaCheck,
  type ScanRole,
  type StepId,
  type ToothDesign,
  unitKind,
} from '@dcad/shared';
import { activeAdapt } from '../design/adaptation';
import { cutbackFor } from '../design/framework';
import { applyCommands } from '../design/reducer';
import { useDesignStore } from '../design/store';
import { sceneController } from '../state/sceneController';
import { bridgeProposalCommands, bridgeRequest, frameView } from '../tools/bridgeTool';
import { fromMarginPoints, toMarginPoints, type ToothContext } from '../tools/context';
import { ALIGN_MIN_DEG, bridgeFramesRequest } from '../tools/frameTool';
import { entryFor, implantCrownRequest, implantMatchCommands, implantTool, isImplantTooth } from '../tools/implantTool';
import { PREP_MARGIN } from '../tools/marginView';
import { isWing, wingSeed } from '../tools/wing';
import type { BridgeRequest, BridgeUnitView, CrownRequest, CrownResult, FrameView } from '../workers/analysisTypes';
import { analysis } from '../workers/geometryClient';
import type { BridgeStepArtifact } from './events';
import {
  adaptGate,
  axisGate,
  bridgeGate,
  crownGate,
  cutbackGate,
  implantPathGate,
  implantSeatGate,
  marginGate,
  scanBodyGate,
  screwChannelGate,
  wingOutlineGate,
} from './qa';

type V3 = [number, number, number];

/** What a proposer suggests: the commands to apply, plus a JSON artifact for ProposalEvent logging. */
export interface ProposalOutput {
  commands: Command[];
  /**
   * The step output for events: one tooth's output, or a BridgeStepArtifact for a bridge-wide proposer (one event per
   * unit); undefined for a gate that proposes nothing.
   */
  artifact: unknown;
}

export type Proposal = Omit<ProposalResult, 'output'> & { output: ProposalOutput };

export interface ProposerRun {
  /** The click on this tooth that started the run: on the prep top, or on the scan body's top (frame, implant position). */
  seed?: V3;
  /** The tooth to run on (default: the active tooth). Bridge proposers design the bridge this tooth belongs to. */
  fdi?: number;
}

/**
 * A step's proposer (the shared Proposer contract): `classical.*` run in
 * the browser/worker today, `ml.*` would be an HTTP job with the same result
 * shape. Proposers read the current (transaction) document and never
 * dispatch; the orchestrator applies `output.commands`.
 */
export interface Proposer {
  id: ProposerId;
  step: StepId;
  /** Bridge auto-design runs it once per abutment (with `fdi`), e.g. the margin. */
  perAbutment?: boolean;
  /**
   * The teeth it runs on (default: all): the margin on a prepared tooth, the scan-body match on an implant crown. A
   * bridge-wide proposer is asked with the tooth the bridge run started from.
   */
  appliesTo?: (doc: DesignDocument, fdi: number) => boolean;
  run(input: ProposerRun): Promise<Proposal>;
}

/** The tooth is a crown on a prepared natural tooth (not an implant crown, not a Maryland wing). */
const naturalPrep = (doc: DesignDocument, fdi: number): boolean => !isImplantTooth(doc, fdi) && !isWing(doc.setup, fdi);
const reducedUnit = (doc: DesignDocument, fdi: number): boolean => cutbackFor(doc, fdi) !== undefined;

const v3 = (p: readonly number[]): V3 => [p[0]!, p[1]!, p[2]!];
const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

const antagonistOf = (role: 'upper' | 'lower'): ScanRole => (role === 'upper' ? 'lower' : 'upper');

/** A tooth (default: the active one) plus its loaded jaw scans. */
function requireContext(fdi?: number): ToothContext {
  const { doc, activeFdi } = useDesignStore.getState();
  const tooth = doc.teeth.find((t) => t.fdi === (fdi ?? activeFdi));
  if (!tooth) throw new Error(`Tooth ${fdi ?? activeFdi} is not in the case`);
  const role = jawOf(tooth.fdi);
  const jaw = sceneController.geometryFor(role);
  if (!jaw) throw new Error('Load the scan with the prep first');
  const antagonist = sceneController.geometryFor(antagonistOf(role));
  return { fdi: tooth.fdi, tooth, jaw: { role, ...jaw }, antagonist: antagonist ? { role: antagonistOf(role), ...antagonist } : null };
}

/**
 * Crown request from the current document (optionally with the stored pose and an adaptation override). An implant
 * crown is designed on its Ti-base (the implant position instead of a margin), with its stored screw channel.
 */
function crownRequest(ctx: ToothContext, opts: { withPose: boolean; adapt?: CrownAdapt }): CrownRequest {
  if (isImplantTooth(useDesignStore.getState().doc, ctx.fdi)) {
    const request = implantCrownRequest(ctx, opts.withPose, 'none');
    if (!request) throw new Error(`The implant crown ${ctx.fdi} needs a frame, the implant position and an axis`);
    return opts.adapt ? { ...request, adapt: opts.adapt } : request;
  }
  const { frame, margin, axis, params, crown } = ctx.tooth;
  if (!frame || !margin || !axis) throw new Error('The crown needs a frame, a margin and an axis');
  return {
    jawSha: ctx.jaw.sha256,
    antagonistSha: ctx.antagonist?.sha256,
    fdi: ctx.fdi,
    frame: {
      origin: v3(frame.origin),
      occlusal: v3(frame.occlusal),
      mesial: v3(frame.mesial),
      buccal: v3(frame.buccal),
      mesialContact: frame.mesialContact && v3(frame.mesialContact),
      distalContact: frame.distalContact && v3(frame.distalContact),
    },
    margin: fromMarginPoints(margin.points),
    axis: v3(axis.direction),
    params,
    pose: opts.withPose && crown?.kind === 'template' ? crown.pose : undefined,
    adapt: opts.adapt ?? (opts.withPose ? activeAdapt(ctx.tooth) : undefined),
  };
}

/** Largest |dot| between the frame axes (0 = orthonormal directions). */
function orthoError(f: Pick<FrameView, 'occlusal' | 'mesial' | 'buccal'>): number {
  return Math.max(Math.abs(dot(f.occlusal, f.mesial)), Math.abs(dot(f.mesial, f.buccal)), Math.abs(dot(f.occlusal, f.buccal)));
}

/**
 * The tooth frame from the click (classical.frame-seed@1). On a crown prep of a front tooth (FDI positions 1–3) the
 * worker turns the occlusal toward the prep's wall axis; a scan body, a wing's natural tooth or a cavity keeps the
 * jaw-level frame, as the Frame step does.
 */
export const frameProposer: Proposer = {
  id: 'classical.frame-seed@1',
  step: 'frame',
  async run({ seed, fdi }) {
    if (!seed) throw new Error('Click the prep first');
    const ctx = requireContext(fdi);
    const restoration = useDesignStore.getState().doc.setup.teeth.find((t) => t.fdi === ctx.fdi)?.restoration;
    const prep = restoration ? PREP_MARGIN.includes(restoration) : true;
    const { warnings, ...frame } = await analysis.estimateFrameUnlatched({
      jawSha: ctx.jaw.sha256,
      antagonistSha: ctx.antagonist?.sha256,
      seed,
      fdi: ctx.fdi,
      prep,
    });
    const ortho = orthoError(frame);
    const contacts = [frame.mesialContact && 'mesial', frame.distalContact && 'distal'].filter(Boolean);
    const qa: QaCheck[] = [
      { id: 'frame.orthonormal', passed: ortho < 1e-3, value: Number(ortho.toFixed(6)), threshold: 1e-3, message: 'Frame axes are orthonormal' },
      // A missing neighbour is legitimate (e.g. the last molar), so contacts are informational.
      { id: 'frame.contacts', passed: true, value: contacts.length, message: contacts.length ? `Neighbour contacts found: ${contacts.join(', ')}` : 'No neighbour contacts found' },
    ];
    return {
      proposerId: this.id,
      output: { commands: [{ type: 'setFrame', fdi: ctx.fdi, frame: { ...frame, source: 'auto' } }], artifact: frame },
      qa,
      rationale: [
        'Occlusal from the arch and local normals, mesial from the arch tangent and FDI handedness.',
        prep && !isPosterior(ctx.fdi)
          ? "On a front-tooth prep the occlusal turns toward the prep's wall axis: unchanged up to 5° from the jaw's occlusal, a ramp from 5° to 10°, the whole wall axis from 10° to 40°, and unchanged (with a warning) above 40°."
          : '',
        ...warnings,
      ]
        .filter(Boolean)
        .join(' '),
    };
  },
};

export const marginProposer: Proposer = {
  id: 'classical.margin-ridge@1',
  step: 'margin',
  appliesTo: naturalPrep,
  async run({ fdi }) {
    const ctx = requireContext(fdi);
    const frame = ctx.tooth.frame;
    if (!frame) throw new Error(`The margin proposer needs the tooth frame of ${ctx.fdi}`);
    const trace = await analysis.autoMargin({
      jawSha: ctx.jaw.sha256,
      frame: { origin: v3(frame.origin), occlusal: v3(frame.occlusal), mesial: v3(frame.mesial) },
    });
    // Closure: the prep region bounded by this margin must not leak.
    const region = await analysis.axisUnlatched({ jawSha: ctx.jaw.sha256, margin: trace.points, occlusal: v3(frame.occlusal), direction: v3(frame.occlusal) });
    const points = toMarginPoints(trace.points);
    const margin = { anchors: trace.anchors.map((p) => ({ p })), points, source: 'auto' as const };
    return {
      proposerId: this.id,
      output: { commands: [{ type: 'setMargin', fdi: ctx.fdi, margin }], artifact: { anchors: trace.anchors, points: points.map((m) => m.p) } },
      qa: marginGate({ points: points.map((m) => m.p), lengthMm: trace.lengthMm, prepClosed: region.prepClosed, confidence: trace.confidence }),
      rationale: `Most convex edge below the axial wall on ${Math.round(trace.confidence * 16)}/16 radial profiles, joined along the ridge (${trace.lengthMm.toFixed(1)} mm).`,
    };
  },
};

/**
 * Wing outline (classical.wing-outline@1), the margin step of a Maryland wing: the lingual (palatal) surface around
 * the frame click, between 0.5 mm above the gingiva and 1.0 mm below the incisal edge or cusp tip, wrapped onto the
 * proximal surface facing the pontic; its boundary as 12 live-wire anchors, more where the live-wire would stray from
 * it (geometry/wingOutline.ts). Gated on a closed outline whose region does not leak and holds a bonded area. When the
 * click lies outside that band, the frame origin (the region's flood-fill seed) moves inside the outline with it.
 */
export const wingOutlineProposer: Proposer = {
  id: 'classical.wing-outline@1',
  step: 'margin',
  appliesTo: (doc, fdi) => isWing(doc.setup, fdi),
  async run({ fdi }) {
    const ctx = requireContext(fdi);
    const doc = useDesignStore.getState().doc;
    const frame = ctx.tooth.frame;
    if (!frame) throw new Error(`Click the lingual surface of ${ctx.fdi} first (Tooth frame)`);
    const toward = connectedSides(doc, ctx.fdi);
    const result = await analysis.wingOutline({
      jawSha: ctx.jaw.sha256,
      frame: { origin: v3(frame.origin), occlusal: v3(frame.occlusal), mesial: v3(frame.mesial), buccal: v3(frame.buccal) },
      toward,
    });
    const points = toMarginPoints(result.points);
    const margin = { anchors: result.anchors.map((p) => ({ p })), points, source: 'auto' as const };
    const commands: Command[] = [
      ...(result.seedMoved ? [{ type: 'setFrame' as const, fdi: ctx.fdi, frame: { ...frame, origin: result.seed } }] : []),
      { type: 'setMargin', fdi: ctx.fdi, margin },
    ];
    return {
      proposerId: this.id,
      output: { commands, artifact: { anchors: result.anchors, points: points.map((m) => m.p) } },
      qa: wingOutlineGate({ anchors: result.anchors.length, points: result.points, regionClosed: result.regionClosed, areaMm2: result.areaMm2 }),
      rationale: [
        `Lingual surface from 0.5 mm above the gingiva to 1.0 mm below the incisal edge (a ${(result.incisalMm - result.gingivaMm - 1.5).toFixed(1)} mm band)${
          toward.length ? `, wrapped onto the ${toward.join(' and ')} surface toward the pontic` : ''
        }: ${result.areaMm2.toFixed(1)} mm² to bond, outlined by ${result.anchors.length} anchors (${result.lengthMm.toFixed(1)} mm).`,
        result.seedMoved ? 'The click was outside that band: the frame origin moved inside the outline.' : '',
        ...result.warnings,
      ]
        .filter(Boolean)
        .join(' '),
    };
  },
};

/** The +z axis of a stored pose's quaternion [x, y, z, w]. */
function poseZ(q: readonly number[]): V3 {
  const [x, y, z, w] = [q[0]!, q[1]!, q[2]!, q[3]!];
  return [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
}

/**
 * Where the scan-body match starts: the click that started this run on the tooth, else the top of the scan body
 * matched before (a re-match), else the frame origin (the frame click on the scan body's top; a match moves the
 * frame down onto the gingival opening, so it is used only before the first match).
 */
function scanBodyClick(tooth: ToothDesign, topZ: number, seed?: V3): V3 {
  if (seed) return seed;
  const pose = tooth.implant?.scanBodyPose;
  if (pose) {
    const z = poseZ(pose.quaternion);
    return [pose.position[0] + z[0] * topZ, pose.position[1] + z[1] * topZ, pose.position[2] + z[2] * topZ];
  }
  if (tooth.frame) return v3(tooth.frame.origin);
  throw new Error(`Click the scan body of ${tooth.fdi} first`);
}

/**
 * Implant position (classical.scan-body-match@1), the margin step of an implant crown: the library scan body
 * matched to the scanned one (click, local PCA, coarse rotation, point-to-plane ICP in the worker), gated on the fit.
 * It stores the tooth frame on the gingival opening, the implant (Ti-base library entry and pose) and, for a single
 * unit, the implant axis as the insertion axis.
 */
export const scanBodyProposer: Proposer = {
  id: 'classical.scan-body-match@1',
  step: 'margin',
  appliesTo: isImplantTooth,
  async run({ seed, fdi }) {
    const ctx = requireContext(fdi);
    const doc = useDesignStore.getState().doc;
    const entry = entryFor(doc, ctx.fdi, await implantTool.loadLibrary());
    if (!entry) throw new Error('No implant library is loaded');
    const frame = ctx.tooth.frame;
    const result = await analysis.registerScanBodyUnlatched({
      jawSha: ctx.jaw.sha256,
      fdi: ctx.fdi,
      click: scanBodyClick(ctx.tooth, entry.scanBodyTopZ, seed),
      libraryId: entry.key,
      ...(frame ? { frame: frameView(frame) } : {}),
    });
    const qa = scanBodyGate(result);
    const single = !bridgeOf(doc, ctx.fdi);
    return {
      proposerId: this.id,
      // A failed match proposes nothing: the draft stops here with the fit on screen in the checks.
      output: {
        commands: result.passed ? implantMatchCommands(doc, ctx.fdi, entry.key, entry, result) : [],
        artifact: { libraryId: entry.key, scanBodyPose: result.pose, fit: { rmsMm: result.rmsMm, inlierFraction: result.inlierFraction, coverage: result.coverage } },
      },
      qa,
      rationale: [
        `Library scan body ${entry.system} ${entry.platform} (${entry.engaging ? 'engaging' : 'non-engaging'}) matched by ICP: RMS ${(result.rmsMm * 1000).toFixed(0)} µm, ${(result.inlierFraction * 100).toFixed(0)}% inliers, ${(result.coverage * 100).toFixed(0)}% coverage.`,
        result.passed ? (single ? 'The implant axis is the insertion axis.' : 'The bridge path is searched over the implant axes next.') : `The match failed: ${result.failures.join('; ')}.`,
      ].join(' '),
    };
  },
};

export const axisProposer: Proposer = {
  id: 'classical.axis-least-undercut@1',
  step: 'axis',
  // An implant crown's axis is its implant axis, stored with the scan-body match.
  appliesTo: naturalPrep,
  async run({ fdi }) {
    const ctx = requireContext(fdi);
    const { frame, margin } = ctx.tooth;
    if (!frame || !margin) throw new Error('The axis proposer needs a frame and a margin');
    const result = await analysis.axisUnlatched({ jawSha: ctx.jaw.sha256, margin: fromMarginPoints(margin.points), occlusal: v3(frame.occlusal) });
    return {
      proposerId: this.id,
      output: { commands: [{ type: 'setAxis', fdi: ctx.fdi, axis: { direction: result.direction, source: 'auto' } }], artifact: { direction: result.direction } },
      qa: axisGate(result),
      rationale: `Least projected undercut within 25° of occlusal: ${result.undercutAreaMm2.toFixed(2)} mm² at ${result.angleFromOcclusalDeg.toFixed(1)}°.`,
    };
  },
};

export const crownProposer: Proposer = {
  id: 'classical.template-crown@1',
  step: 'proposal',
  async run({ fdi }) {
    const ctx = requireContext(fdi);
    const result = await analysis.designCrownUnlatched(crownRequest(ctx, { withPose: false }));
    const crown = { kind: 'template' as const, templateId: result.templateId, pose: result.pose };
    const placed = result.implant
      ? 'placed on the gingival opening around the implant, with the emergence profile down to the Ti-base,'
      : 'placed in the tooth frame,';
    return {
      proposerId: this.id,
      output: { commands: [{ type: 'setCrown', fdi: ctx.fdi, crown }], artifact: crown },
      qa: [...crownGate(result, ctx.tooth.params), ...(result.implant ? implantSeatGate(result.implant) : [])],
      rationale: `Template ${result.templateId} ${placed} sized to the contacts, margin and antagonist space.${result.warnings.length ? ` ${result.warnings.join(' ')}` : ''}`,
    };
  },
};

/** The worker request for one unit of a bridge as it is designed in the bridge (common axis, stored pose), for the auto channel. */
function bridgeUnitRequest(doc: DesignDocument, fdi: number): CrownRequest {
  const request = requireBridgeRequest(doc, fdi, {});
  const unit = request.units.find((u) => u.fdi === fdi);
  if (!unit?.frame || !unit.implant) throw new Error(`${fdi} needs its frame and implant position`);
  return {
    jawSha: request.jawSha,
    ...(request.antagonistSha ? { antagonistSha: request.antagonistSha } : {}),
    fdi,
    frame: unit.frame,
    margin: new Float32Array(0),
    axis: request.axis,
    params: unit.params,
    ...(unit.pose ? { pose: unit.pose } : {}),
    implant: unit.implant,
  };
}

/**
 * Screw channel (classical.screw-channel@1), on the proposed implant crown: straight when its exit is occlusal
 * (lingual on anterior teeth) with enough wall, else the smallest angle in the Ti-base library's angled-channel cone
 * that passes. A single unit is designed again with the channel cut and gated on that restoration; in a bridge the
 * connector and union gate re-checks every channel on the merged solid.
 */
export const screwChannelProposer: Proposer = {
  id: 'classical.screw-channel@1',
  step: 'proposal',
  appliesTo: isImplantTooth,
  async run({ fdi }) {
    const ctx = requireContext(fdi);
    const doc = useDesignStore.getState().doc;
    const bridged = Boolean(bridgeOf(doc, ctx.fdi));
    const request = bridged ? bridgeUnitRequest(doc, ctx.fdi) : crownRequest(ctx, { withPose: true });
    if (!request.pose) throw new Error(`Propose the ${bridged ? 'bridge' : 'crown'} first: the screw channel is placed on it`);
    const found = await analysis.screwChannelAuto(request);
    const ascMax = ctx.tooth.implant?.ascMaxDeg ?? 0;
    const requiredWallMm = request.params.channelWallMm ?? DEFAULT_CHANNEL_WALL_MM;
    if (!found) {
      return {
        proposerId: this.id,
        output: { commands: [], artifact: undefined },
        qa: screwChannelGate(null),
        rationale: `No channel angle up to the library's ${ascMax}° exits ${occlusalOrLingual(ctx.fdi)} with ${requiredWallMm} mm of material around it: the unit cannot be screw-retained as designed (a thinner wall, if the lab allows it, or a cement-retained design).`,
      };
    }
    const channel = { angleDeg: found.angleDeg, azimuthDeg: found.azimuthDeg };
    let qa: QaCheck[];
    if (bridged) {
      qa = screwChannelGate({ exitOk: found.exitOk, minWallMm: found.minWallMm, requiredWallMm, wallOk: found.minWallMm >= requiredWallMm - 1e-6 });
    } else {
      const cut = await analysis.designCrownUnlatched({ ...request, implant: { ...request.implant!, channel } });
      const view = cut.implant;
      qa = view ? screwChannelGate(view.channel, { ok: Boolean(view.cut) && view.cutOk !== false }) : screwChannelGate(null);
    }
    return {
      proposerId: this.id,
      output: { commands: [{ type: 'setScrewChannel', fdi: ctx.fdi, ...channel }], artifact: channel },
      qa,
      rationale:
        found.angleDeg === 0
          ? `Straight channel along the implant axis: it exits ${occlusalOrLingual(ctx.fdi)} with ${found.minWallMm.toFixed(2)} mm of wall.`
          : `A straight channel would exit ${isPosterior(ctx.fdi) ? 'buccally or proximally' : 'labially or incisally'} or leave too thin a wall: angled ${found.angleDeg}° toward ${azimuthName(found.azimuthDeg)} (library maximum ${ascMax}°), exiting ${occlusalOrLingual(ctx.fdi)} with ${found.minWallMm.toFixed(2)} mm of wall.`,
    };
  },
};

/** As geometry/implantCrown.ts DEFAULT_CHANNEL_WALL_MM (the worker's default when the parameter is unset). */
const DEFAULT_CHANNEL_WALL_MM = 0.8;
const occlusalOrLingual = (fdi: number) => (isPosterior(fdi) ? 'occlusally' : 'lingually');
/** The tilt direction of a channel azimuth (0 buccal, 90 mesial, 180 lingual, 270 distal). */
function azimuthName(deg: number): string {
  const names = ['buccal', 'mesio-buccal', 'mesial', 'mesio-lingual', 'lingual', 'disto-lingual', 'distal', 'disto-buccal'];
  return names[Math.round((((deg % 360) + 360) % 360) / 45) % 8]!;
}

// ---- adaptation (single crowns and bridges) ----------------------------------------------------

const hasTargets = (a: CrownAdapt): boolean => Boolean(a.occlusion || a.mesial || a.distal);

/** Adaptation targets from the parameters: occlusion when there is an antagonist, contacts on free sides only. */
function adaptTargets(tooth: ToothDesign, connected: readonly ProximalSide[], antagonist: boolean): CrownAdapt {
  const { params, frame } = tooth;
  return {
    ...(antagonist ? { occlusion: { clearanceMm: params.occlusalClearanceMm } } : {}),
    // A side facing a connected bridge unit has a connector, not a contact.
    ...(frame?.mesialContact && !connected.includes('mesial') ? { mesial: { targetMm: params.proximalContactMm } } : {}),
    ...(frame?.distalContact && !connected.includes('distal') ? { distal: { targetMm: params.proximalContactMm } } : {}),
  };
}

function adaptCommands(fdi: number, adapt: CrownAdapt): Command[] {
  const commands: Command[] = [];
  if (adapt.occlusion) commands.push({ type: 'adaptOcclusion', fdi, clearanceMm: adapt.occlusion.clearanceMm });
  if (adapt.mesial) commands.push({ type: 'setContact', fdi, side: 'mesial', targetMm: adapt.mesial.targetMm });
  if (adapt.distal) commands.push({ type: 'setContact', fdi, side: 'distal', targetMm: adapt.distal.targetMm });
  return commands;
}

/** Checks of one bridge unit, named per unit (`crown.valid.35`, "35: …"). */
const forUnit = (fdi: number, qa: readonly QaCheck[]): QaCheck[] => qa.map((c) => ({ ...c, id: `${c.id}.${fdi}`, message: `${fdi}: ${c.message}` }));

/**
 * A bridge unit's checks, named per unit. A pontic is solid: no thickness check. A Maryland wing has its own minimum
 * thickness, checked with the wing checks in bridgeGate. An implant crown must seat on its Ti-base along the path.
 */
function unitChecks(
  unit: Pick<BridgeUnitView, 'fdi' | 'kind' | 'wing' | 'implant'> & Parameters<typeof crownGate>[0],
  params: ToothDesign['params'],
  extra: QaCheck[] = [],
): QaCheck[] {
  const crown = crownGate(unit, params).filter((c) => (unit.kind === 'abutment' && !unit.wing) || c.id !== 'crown.thickness');
  return forUnit(unit.fdi, [...extra, ...crown, ...(unit.implant ? implantSeatGate(unit.implant) : [])]);
}

const paramsOf = (doc: DesignDocument, fdi: number): ToothDesign['params'] => doc.teeth.find((t) => t.fdi === fdi)!.params;

/**
 * classical.adapt@1, bridge-aware: occlusion and the free-side contacts from the parameters, on every unit of a
 * bridge (sides facing a connected unit have a connector). The artifact of a bridge carries the connector settings.
 */
export const adaptProposer: Proposer = {
  id: 'classical.adapt@1',
  step: 'adapt',
  async run({ fdi }) {
    const ctx = requireContext(fdi);
    const doc = useDesignStore.getState().doc;
    const bridge = bridgeOf(doc, ctx.fdi);
    if (bridge) return adaptBridge(this.id, doc, ctx, bridge);
    const { params } = ctx.tooth;
    const adapt = adaptTargets(ctx.tooth, connectedSides(doc, ctx.fdi), Boolean(ctx.antagonist));
    const commands = adaptCommands(ctx.fdi, adapt);
    if (commands.length === 0) {
      return {
        proposerId: this.id,
        output: { commands, artifact: adapt },
        qa: [{ id: 'adapt.applied', passed: true, message: 'Nothing to adapt to (no antagonist or neighbours)' }],
        rationale: 'No antagonist or neighbour contacts in the scans.',
      };
    }
    const result = await analysis.designCrownUnlatched(crownRequest(ctx, { withPose: true, adapt }));
    return {
      proposerId: this.id,
      output: { commands, artifact: adapt },
      qa: [...adaptGate(result), ...crownGate(result, params)],
      rationale: `Clearance targets from the parameters: occlusal ${params.occlusalClearanceMm} mm, proximal ${params.proximalContactMm} mm.`,
    };
  },
};

async function adaptBridge(id: ProposerId, doc: DesignDocument, ctx: ToothContext, bridge: BridgeDesign): Promise<Proposal> {
  const targets: Record<number, CrownAdapt> = {};
  const commands: Command[] = [];
  for (const fdi of bridge.teeth) {
    const tooth = doc.teeth.find((t) => t.fdi === fdi)!;
    // A Maryland wing follows its outline: its space against the antagonist is a wing check (bridgeGate), not an
    // adaptation, and it has no contacts.
    targets[fdi] = isWing(doc.setup, fdi) ? {} : adaptTargets(tooth, connectedSides(doc, fdi), Boolean(ctx.antagonist));
    commands.push(...adaptCommands(fdi, targets[fdi]));
  }
  const artifact: BridgeStepArtifact = { units: bridge.teeth.map((fdi) => ({ fdi, artifact: targets[fdi] })), connectors: bridge.connectors };
  if (commands.length === 0) {
    return {
      proposerId: id,
      output: { commands, artifact },
      qa: [{ id: 'adapt.applied', passed: true, message: 'Nothing to adapt to (no antagonist or free-side neighbours)' }],
      rationale: 'No antagonist, and no natural neighbour on a free side.',
    };
  }
  const result = await analysis.designBridgeUnlatched(requireBridgeRequest(doc, ctx.fdi, { adapt: targets }));
  const qa = result.units.flatMap((u) => unitChecks(u, paramsOf(doc, u.fdi), hasTargets(targets[u.fdi] ?? {}) ? adaptGate(u) : []));
  const params = paramsOf(doc, ctx.fdi);
  return {
    proposerId: id,
    output: { commands, artifact },
    qa,
    rationale: [
      `Every unit adapted to the antagonist (${params.occlusalClearanceMm} mm) and, on free sides, to its natural neighbour (${params.proximalContactMm} mm). Sides joined by a connector have no contact.`,
      bridge.teeth.some((t) => isWing(doc.setup, t)) ? 'Wings follow their outline: their space to the antagonist is checked with the bridge.' : '',
    ]
      .filter(Boolean)
      .join(' '),
  };
}

// ---- cutback (reduced units) -------------------------------------------------------------------

/**
 * classical.cutback@1's cutback for a material: metal frameworks get the metal-ceramic design (facial: buccal and
 * occlusal third cut back by 1.2 mm, lingual at full contour), ceramic frameworks a full 1.0 mm cutback for layering
 * or pressing. Collar and overpress stay as set.
 */
const CUTBACK_FOR: Record<Material, Pick<Cutback, 'mode' | 'thicknessMm'>> = {
  zirconia: { mode: 'full', thicknessMm: 1.0 },
  'lithium-disilicate': { mode: 'full', thicknessMm: 1.0 },
  pmma: { mode: 'full', thicknessMm: 1.0 },
  cocr: { mode: 'facial', thicknessMm: 1.2 },
  titanium: { mode: 'facial', thicknessMm: 1.2 },
};

const materialOf = (doc: DesignDocument, fdi: number): Material => doc.setup.teeth.find((t) => t.fdi === fdi)?.material ?? 'zirconia';

/** The setCutback commands for reduced units: mode and veneering space from the material. */
function cutbackCommands(doc: DesignDocument, teeth: readonly number[]): Command[] {
  return teeth.filter((fdi) => reducedUnit(doc, fdi)).map((fdi) => ({ type: 'setCutback', fdi, ...CUTBACK_FOR[materialOf(doc, fdi)] }));
}

const describeCutback = (c: Pick<Cutback, 'mode' | 'thicknessMm'>) => `${c.mode} cutback of ${c.thicknessMm} mm`;

/**
 * Cutback (classical.cutback@1), after the adaptation: each reduced unit is cut back by the veneering space its
 * material calls for, keeping the framework minimum (thickness protection). Gated on the measured veneer: a shortfall
 * of more than CUTBACK_MAX_DEFICIT_MM ("insufficient veneering space") stops the draft, and on the framework being a
 * printable solid. In a bridge every reduced unit at once; the connector gate then merges the frameworks.
 */
export const cutbackProposer: Proposer = {
  id: 'classical.cutback@1',
  step: 'adapt',
  appliesTo: (doc, fdi) => (bridgeOf(doc, fdi)?.teeth ?? [fdi]).some((t) => reducedUnit(doc, t)),
  async run({ fdi }) {
    const ctx = requireContext(fdi);
    const doc = useDesignStore.getState().doc;
    const bridge = bridgeOf(doc, ctx.fdi);
    const commands = cutbackCommands(doc, bridge?.teeth ?? [ctx.fdi]);
    const next = applyCommands(doc, commands);
    const proposed = (t: number) => cutbackFor(next, t)!;
    const rationale = `${describeCutback(CUTBACK_FOR[materialOf(doc, ctx.fdi)])} for ${materialOf(doc, ctx.fdi)}, on top of the adapted anatomy, keeping the framework minimum.`;
    if (!bridge) {
      const result: CrownResult = await analysis.designCrownUnlatched({ ...crownRequest(ctx, { withPose: true }), cutback: proposed(ctx.fdi) });
      return { proposerId: this.id, output: { commands, artifact: proposed(ctx.fdi) }, qa: cutbackGate(result.framework), rationale };
    }
    const reduced = bridge.teeth.filter((t) => reducedUnit(doc, t));
    const result = await analysis.designBridgeUnlatched(requireBridgeRequest(next, ctx.fdi, {}));
    const qa = reduced.flatMap((t) => forUnit(t, cutbackGate(result.units.find((u) => u.fdi === t)?.framework)));
    return {
      proposerId: this.id,
      output: { commands, artifact: { units: reduced.map((t) => ({ fdi: t, artifact: proposed(t) })) } satisfies BridgeStepArtifact },
      qa,
      rationale: `${reduced.join(', ')}: ${rationale}`,
    };
  },
};

// ---- bridges ---------------------------------------------------------------------------------

/** The bridge that `fdi` (default: the active tooth) belongs to. */
function requireBridge(fdi?: number): { doc: DesignDocument; fdi: number; bridge: BridgeDesign; abutments: number[] } {
  const { doc, activeFdi } = useDesignStore.getState();
  const f = fdi ?? activeFdi;
  const bridge = bridgeOf(doc, f);
  if (!bridge) throw new Error(`Tooth ${f} is not part of a bridge`);
  return { doc, fdi: f, bridge, abutments: bridge.teeth.filter((t) => unitKind(doc.setup, t) === 'abutment') };
}

function requireBridgeRequest(doc: DesignDocument, fdi: number, opts: Parameters<typeof bridgeRequest>[2]): BridgeRequest {
  const request = bridgeRequest(doc, fdi, opts);
  if (!request) throw new Error(`Tooth ${fdi} is not part of a bridge`);
  return request;
}

/** The chart neighbour on the mesial side (the other central across the midline) and on the distal side. */
function neighbours(fdi: number): { mesial: number; distal: number | null } {
  const q = Math.floor(fdi / 10);
  const pos = fdi % 10;
  const mesial = pos === 1 ? ({ 1: 21, 2: 11, 3: 41, 4: 31 } as Record<number, number>)[q]! : fdi - 1;
  return { mesial, distal: pos < 8 ? fdi + 1 : null };
}

/**
 * Bridge frames (classical.pontic-frame@1): every pontic's frame laid out on the arch curve between its neighbours
 * (cantilevers one width beyond), and every automatic abutment frame aligned to the arch (its mesial-distal line from
 * the curve, as the pipeline runner does: a click next to a gap can be far off). Manual frames are kept.
 */
export const ponticFrameProposer: Proposer = {
  id: 'classical.pontic-frame@1',
  step: 'frame',
  async run({ fdi }) {
    const { doc, fdi: f, bridge, abutments } = requireBridge(fdi);
    const request = bridgeFramesRequest(doc, f);
    if (!request) throw new Error('Load the scan and set the frame of every abutment first');
    const result = await analysis.bridgeFramesUnlatched(request);
    const stored = (t: number) => doc.teeth.find((x) => x.fdi === t)?.frame;
    const frames = new Map<number, FrameView>();
    for (const t of bridge.teeth) {
      const fr = stored(t);
      if (fr) frames.set(t, frameView(fr));
    }
    const commands: Command[] = [];
    const proposed = new Map<number, FrameView>();
    const aligned: string[] = [];
    for (const a of result.abutments) {
      if (a.changeDeg < ALIGN_MIN_DEG || stored(a.fdi)?.source === 'manual') continue;
      proposed.set(a.fdi, a.frame);
      aligned.push(`${a.fdi} by ${a.changeDeg.toFixed(1)}°`);
    }
    for (const p of result.pontics) if (stored(p.fdi)?.source !== 'manual') proposed.set(p.fdi, p.frame);
    // Abutments first: a new abutment frame marks the pontic frames stale, and the pontic frames follow in the batch.
    const order = [...proposed.keys()].sort((a, b) => bridge.teeth.indexOf(a) - bridge.teeth.indexOf(b));
    for (const t of order.filter((t) => unitKind(doc.setup, t) === 'abutment')) commands.push({ type: 'setFrame', fdi: t, frame: { ...proposed.get(t)!, source: 'auto' } });
    for (const t of order.filter((t) => unitKind(doc.setup, t) === 'pontic')) commands.push({ type: 'setFrame', fdi: t, frame: { ...proposed.get(t)!, source: 'auto' } });
    for (const [t, fr] of proposed) frames.set(t, fr);

    const qa: QaCheck[] = [];
    for (const t of order) {
      const fr = frames.get(t)!;
      const ortho = orthoError(fr);
      qa.push({ id: `frame.orthonormal.${t}`, passed: ortho < 1e-3, value: Number(ortho.toFixed(6)), threshold: 1e-3, message: `${t}: frame axes are orthonormal` });
    }
    // FDI handedness of each pontic: mesial points toward its mesial neighbour (or away from its distal one).
    for (const p of result.pontics) {
      const fr = frames.get(p.fdi)!;
      const n = neighbours(p.fdi);
      const toward = frames.has(n.mesial) ? n.mesial : n.distal !== null && frames.has(n.distal) ? n.distal : null;
      if (toward === null) continue;
      const o = frames.get(toward)!.origin;
      const d: V3 = [o[0] - fr.origin[0], o[1] - fr.origin[1], o[2] - fr.origin[2]];
      const len = Math.hypot(...d) || 1;
      const value = (dot(fr.mesial, d) / len) * (toward === n.mesial ? 1 : -1);
      qa.push({ id: `frame.handedness.${p.fdi}`, passed: value > 0.5, value: Number(value.toFixed(3)), threshold: 0.5, message: `${p.fdi}: mesial points along the arch toward ${n.mesial} (FDI handedness)` });
    }
    const pontics = result.pontics.map((p) => `${p.fdi}${p.cantilever ? ' (cantilever)' : ''}`);
    // Without margins the abutments' edges are estimates: the bridge proposal lays the pontics out again between the
    // retainer shells, so the layout's width warnings would mislead here.
    const provisional = abutments.some((t) => !doc.teeth.find((x) => x.fdi === t)?.margin);
    const warnings = [
      ...result.curve.warnings,
      ...(provisional ? ['Provisional until the margins are traced: the bridge proposal places the pontics between the retainers.'] : result.pontics.flatMap((p) => p.warnings)),
    ];
    return {
      proposerId: this.id,
      output: { commands, artifact: { units: order.map((t) => ({ fdi: t, artifact: proposed.get(t) })) } satisfies BridgeStepArtifact },
      qa,
      rationale: [
        pontics.length
          ? `Pontic${pontics.length === 1 ? '' : 's'} ${pontics.join(', ')} laid out on the arch curve (${result.curve.kind}, ${result.curve.lengthMm.toFixed(0)} mm).`
          : 'No pontics: splinted crowns.',
        aligned.length ? `Abutment frames aligned to the arch: ${aligned.join(', ')}.` : '',
        ...warnings,
      ]
        .filter(Boolean)
        .join(' '),
    };
  },
};

/**
 * The common insertion path of an implant bridge: the centre of the smallest cone around the implant axes, gated on
 * their divergence against the Ti-base library's maximum.
 */
async function implantBridgeAxis(id: ProposerId, teeth: readonly ToothDesign[]): Promise<Proposal> {
  const unmatched = teeth.filter((t) => !t.implant).map((t) => t.fdi);
  if (unmatched.length) throw new Error(`Match the scan body on ${unmatched.join(', ')} first`);
  const path = await analysis.implantPath({ implants: teeth.map((t) => ({ fdi: t.fdi, pose: t.implant!.scanBodyPose, libraryId: t.implant!.libraryId })) });
  const direction = path.direction;
  return {
    proposerId: id,
    output: {
      commands: [{ type: 'setAxis', fdi: teeth[0]!.fdi, axis: { direction, source: 'auto' } }],
      artifact: { units: teeth.map((t) => ({ fdi: t.fdi, artifact: { direction } })) } satisfies BridgeStepArtifact,
    },
    qa: implantPathGate(path),
    rationale: [
      `Common path over the ${teeth.length} implant axes: they diverge by ${path.divergenceDeg.toFixed(1)}° (Ti-base library maximum ${path.maxDivergenceDeg}°);`,
      `each Ti-base is at most ${Math.max(...path.implants.map((i) => i.angleToPathDeg)).toFixed(1)}° off the path.`,
      ...path.failures,
    ].join(' '),
  };
}

/**
 * The common insertion axis of a bridge (classical.bridge-axis@1): one least-undercut search over every abutment
 * prep (a Maryland wing's region is flood-filled from its frame click), or the common path over the implant axes of
 * an implant bridge.
 */
export const bridgeAxisProposer: Proposer = {
  id: 'classical.bridge-axis@1',
  step: 'axis',
  async run({ fdi }) {
    const { doc, abutments } = requireBridge(fdi);
    const teeth = abutments.map((t) => doc.teeth.find((x) => x.fdi === t)!);
    // validateBridges refuses bridges that mix implant and natural support.
    if (abutments.some((t) => isImplantTooth(doc, t))) return implantBridgeAxis(this.id, teeth);
    const ctx = requireContext(abutments[0]);
    const missing = teeth.filter((t) => !t.frame || !t.margin).map((t) => t.fdi);
    if (missing.length) throw new Error(`Set the frame and ${teeth.some((t) => isWing(doc.setup, t.fdi)) ? 'margin or wing outline' : 'margin'} on ${missing.join(', ')} first`);
    const result = await analysis.bridgeAxisUnlatched({
      jawSha: ctx.jaw.sha256,
      abutments: teeth.map((t) => ({
        fdi: t.fdi,
        margin: fromMarginPoints(t.margin!.points),
        occlusal: v3(t.frame!.occlusal),
        ...wingSeed(doc.setup, t.fdi, t.frame),
      })),
    });
    const direction = result.direction;
    const qa: QaCheck[] = [
      ...axisGate({ marginUndercutCount: result.marginUndercutTotal, angleFromOcclusalDeg: result.angleFromCenterDeg, prepClosed: result.prepClosed }),
      // Divergent abutments force blockout; a warning, not a gate (long spans often diverge).
      { id: 'axis.divergence', passed: true, value: Number(result.divergenceDeg.toFixed(2)), threshold: 12, message: "Largest angle between the abutments' own best axes (a warning above 12°)" },
    ];
    return {
      proposerId: this.id,
      // The reducer stores the same axis on every abutment of the bridge.
      output: { commands: [{ type: 'setAxis', fdi: abutments[0]!, axis: { direction, source: 'auto' } }], artifact: { units: abutments.map((t) => ({ fdi: t, artifact: { direction } })) } satisfies BridgeStepArtifact },
      qa,
      rationale: [
        `Least projected undercut over the ${abutments.length} abutment${abutments.length === 1 ? '' : 's'} within 25° of their mean occlusal direction: ${result.undercutAreaMm2.toFixed(2)} mm² at ${result.angleFromCenterDeg.toFixed(1)}°.`,
        ...result.warnings,
      ].join(' '),
    };
  },
};

/** The bridge proposal (classical.bridge-proposal@1): every unit at once, as "Propose bridge" does, as one batch. */
export const bridgeProposalProposer: Proposer = {
  id: 'classical.bridge-proposal@1',
  step: 'proposal',
  async run({ fdi }) {
    const { doc, fdi: f } = requireBridge(fdi);
    const result = await analysis.designBridgeUnlatched(requireBridgeRequest(doc, f, { withPoses: false, adapt: 'none' }));
    const pontics = result.units.filter((u) => u.kind === 'pontic').map((u) => `${u.fdi}${u.layout ? ` (${u.layout.mdMm.toFixed(1)} mm wide${u.layout.cantilever ? ', cantilever' : ''})` : ''}`);
    const abutments = result.units.filter((u) => u.kind === 'abutment');
    const retainers = abutments.some((u) => u.implant)
      ? 'Implant crowns placed on the gingival openings around their implants'
      : [abutments.some((u) => u.wing) ? 'Wings derived from their outlines' : '', abutments.some((u) => !u.wing) ? 'retainers placed on their margins' : '']
          .filter(Boolean)
          .join(', ')
          .replace(/^./, (c) => c.toUpperCase());
    return {
      proposerId: this.id,
      output: {
        commands: bridgeProposalCommands(doc, result),
        artifact: { units: result.units.map((u) => ({ fdi: u.fdi, artifact: { kind: 'template', templateId: u.templateId, pose: u.pose } })) } satisfies BridgeStepArtifact,
      },
      qa: result.units.flatMap((u) => unitChecks(u, paramsOf(doc, u.fdi))),
      rationale: [
        `${retainers}${pontics.length ? ` and pontic${pontics.length === 1 ? '' : 's'} ${pontics.join(', ')} on the arch` : ''}, all along the common axis.`,
        ...result.warnings,
      ].join(' '),
    };
  },
};

/**
 * Connector and union gate (classical.connectors@1): the connectors are derived geometry, so this proposes nothing.
 * It merges the bridge into one solid and runs bridgeGate on it: connector sections and heights measured on the
 * union, one closed printable solid, seating unchanged, pontic bases on the ridge.
 */
export const connectorsProposer: Proposer = {
  id: 'classical.connectors@1',
  step: 'adapt',
  async run({ fdi }) {
    const { doc, fdi: f } = requireBridge(fdi);
    const result = await analysis.designBridgeUnlatched(requireBridgeRequest(doc, f, { union: true }));
    const measured = (result.union?.checks.connectors ?? []).map((c) => `${c.between[0]}–${c.between[1]} ${c.measured.minAreaMm2.toFixed(1)} mm² × ${c.measured.heightMm.toFixed(1)} mm`);
    const channels = result.units.filter((u) => u.implant).length;
    return {
      proposerId: this.id,
      output: { commands: [], artifact: undefined },
      qa: bridgeGate(result),
      rationale: result.union
        ? `Merged into one solid${channels ? ` with ${channels} screw channel${channels === 1 ? '' : 's'}` : ''}; connectors measured on it: ${measured.join(', ')}.`
        : `The units could not be merged: ${result.unionError ?? 'no union'}.`,
    };
  },
};

/**
 * Single-unit auto-design order: frame → margin (a prepared tooth) or implant position (an implant crown) → axis (the
 * implant axis comes with the implant position) → crown → screw channel (implant crowns) → adaptation → cutback
 * (reduced crowns). The orchestrator keeps the proposers that apply to the tooth.
 */
export const PROPOSERS: readonly Proposer[] = [
  frameProposer,
  marginProposer,
  scanBodyProposer,
  axisProposer,
  crownProposer,
  screwChannelProposer,
  adaptProposer,
  cutbackProposer,
];

/**
 * Bridge auto-design order, after a frame on every abutment: pontic frames (and abutments aligned to the arch) →
 * each abutment's margin, implant position or wing outline → the common axis (the implant path in an implant bridge)
 * → every unit → each implant crown's screw channel → adaptation → the cutback of reduced units → the connector and
 * union gate.
 */
export const BRIDGE_PROPOSERS: readonly Proposer[] = [
  ponticFrameProposer,
  { ...marginProposer, perAbutment: true },
  { ...scanBodyProposer, perAbutment: true },
  { ...wingOutlineProposer, perAbutment: true },
  bridgeAxisProposer,
  bridgeProposalProposer,
  { ...screwChannelProposer, perAbutment: true },
  adaptProposer,
  cutbackProposer,
  connectorsProposer,
];

import {
  bridgeOf,
  type BridgeDesign,
  type Command,
  connectedSides,
  type CrownAdapt,
  type DesignDocument,
  jawOf,
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
import { useDesignStore } from '../design/store';
import { sceneController } from '../state/sceneController';
import { bridgeProposalCommands, bridgeRequest, frameView } from '../tools/bridgeTool';
import { fromMarginPoints, toMarginPoints, type ToothContext } from '../tools/context';
import { ALIGN_MIN_DEG, bridgeFramesRequest } from '../tools/frameTool';
import type { BridgeRequest, BridgeUnitView, CrownRequest, FrameView } from '../workers/analysisTypes';
import { analysis } from '../workers/geometryClient';
import type { BridgeStepArtifact } from './events';
import { adaptGate, axisGate, bridgeGate, crownGate, marginGate } from './qa';

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
  /** Seed click on the prep (frame proposer only). */
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
  run(input: ProposerRun): Promise<Proposal>;
}

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

/** Crown request from the current document (optionally with the stored pose and an adaptation override). */
function crownRequest(ctx: ToothContext, opts: { withPose: boolean; adapt?: CrownAdapt }): CrownRequest {
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

export const frameProposer: Proposer = {
  id: 'classical.frame-seed@1',
  step: 'frame',
  async run({ seed, fdi }) {
    if (!seed) throw new Error('Click the prep first');
    const ctx = requireContext(fdi);
    const { warnings, ...frame } = await analysis.estimateFrameUnlatched({
      jawSha: ctx.jaw.sha256,
      antagonistSha: ctx.antagonist?.sha256,
      seed,
      fdi: ctx.fdi,
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
      rationale: ['Occlusal from the arch and local normals, mesial from the arch tangent and FDI handedness.', ...warnings].join(' '),
    };
  },
};

export const marginProposer: Proposer = {
  id: 'classical.margin-ridge@1',
  step: 'margin',
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

export const axisProposer: Proposer = {
  id: 'classical.axis-least-undercut@1',
  step: 'axis',
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
    return {
      proposerId: this.id,
      output: { commands: [{ type: 'setCrown', fdi: ctx.fdi, crown }], artifact: crown },
      qa: crownGate(result, ctx.tooth.params),
      rationale: `Template ${result.templateId} placed in the tooth frame, sized to the contacts, margin and antagonist space.${result.warnings.length ? ` ${result.warnings.join(' ')}` : ''}`,
    };
  },
};

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

/** A bridge unit's checks, named per unit (`crown.valid.35`, "35: …"). A pontic is solid: no thickness check. */
function unitChecks(unit: Pick<BridgeUnitView, 'fdi' | 'kind'> & Parameters<typeof crownGate>[0], params: ToothDesign['params'], extra: QaCheck[] = []): QaCheck[] {
  const crown = crownGate(unit, params).filter((c) => unit.kind === 'abutment' || c.id !== 'crown.thickness');
  return [...extra, ...crown].map((c) => ({ ...c, id: `${c.id}.${unit.fdi}`, message: `${unit.fdi}: ${c.message}` }));
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
    targets[fdi] = adaptTargets(tooth, connectedSides(doc, fdi), Boolean(ctx.antagonist));
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
    rationale: `Every unit adapted to the antagonist (${params.occlusalClearanceMm} mm) and, on free sides, to its natural neighbour (${params.proximalContactMm} mm). Sides joined by a connector have no contact.`,
  };
}

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

/** The common insertion axis of a bridge (classical.bridge-axis@1): one least-undercut search over every abutment prep. */
export const bridgeAxisProposer: Proposer = {
  id: 'classical.bridge-axis@1',
  step: 'axis',
  async run({ fdi }) {
    const { doc, abutments } = requireBridge(fdi);
    const ctx = requireContext(abutments[0]);
    const teeth = abutments.map((t) => doc.teeth.find((x) => x.fdi === t)!);
    const missing = teeth.filter((t) => !t.frame || !t.margin).map((t) => t.fdi);
    if (missing.length) throw new Error(`Set the frame and margin on ${missing.join(', ')} first`);
    const result = await analysis.bridgeAxisUnlatched({
      jawSha: ctx.jaw.sha256,
      abutments: teeth.map((t) => ({ fdi: t.fdi, margin: fromMarginPoints(t.margin!.points), occlusal: v3(t.frame!.occlusal) })),
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
        `Least projected undercut over the ${abutments.length} abutment preps within 25° of their mean occlusal direction: ${result.undercutAreaMm2.toFixed(2)} mm² at ${result.angleFromCenterDeg.toFixed(1)}°.`,
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
    return {
      proposerId: this.id,
      output: {
        commands: bridgeProposalCommands(doc, result),
        artifact: { units: result.units.map((u) => ({ fdi: u.fdi, artifact: { kind: 'template', templateId: u.templateId, pose: u.pose } })) } satisfies BridgeStepArtifact,
      },
      qa: result.units.flatMap((u) => unitChecks(u, paramsOf(doc, u.fdi))),
      rationale: [
        `Retainers placed on their margins${pontics.length ? ` and pontic${pontics.length === 1 ? '' : 's'} ${pontics.join(', ')} on the arch` : ''}, all along the common axis.`,
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
    return {
      proposerId: this.id,
      output: { commands: [], artifact: undefined },
      qa: bridgeGate(result),
      rationale: result.union
        ? `Merged into one solid; connectors measured on it: ${measured.join(', ')}.`
        : `The units could not be merged: ${result.unionError ?? 'no union'}.`,
    };
  },
};

/** Auto-design pipeline order. */
export const PROPOSERS: readonly Proposer[] = [frameProposer, marginProposer, axisProposer, crownProposer, adaptProposer];

/**
 * Bridge auto-design order, after a frame on every abutment: pontic frames (and abutments aligned to the arch) →
 * each abutment's margin → the common axis → every unit → adaptation → the connector and union gate.
 */
export const BRIDGE_PROPOSERS: readonly Proposer[] = [
  ponticFrameProposer,
  { ...marginProposer, perAbutment: true },
  bridgeAxisProposer,
  bridgeProposalProposer,
  adaptProposer,
  connectorsProposer,
];

export const proposerForStep = (step: StepId): Proposer | undefined => PROPOSERS.find((p) => p.step === step);

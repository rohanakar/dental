import { type Command, connectedSides, type CrownAdapt, type ProposalResult, type ProposerId, type QaCheck, type StepId } from '@dcad/shared';
import { activeAdapt } from '../design/adaptation';
import { useDesignStore } from '../design/store';
import { fromMarginPoints, toMarginPoints, toothContext, type ToothContext } from '../tools/context';
import type { CrownRequest } from '../workers/analysisTypes';
import { analysis } from '../workers/geometryClient';
import { adaptGate, axisGate, crownGate, marginGate } from './qa';

type V3 = [number, number, number];

/** What a proposer suggests: the commands to apply, plus a JSON artifact for ProposalEvent logging. */
export interface ProposalOutput {
  commands: Command[];
  artifact: unknown;
}

export type Proposal = Omit<ProposalResult, 'output'> & { output: ProposalOutput };

export interface ProposerRun {
  /** Seed click on the prep (frame proposer only). */
  seed?: V3;
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
  run(input: ProposerRun): Promise<Proposal>;
}

const v3 = (p: readonly number[]): V3 => [p[0]!, p[1]!, p[2]!];

function requireContext(): ToothContext {
  const ctx = toothContext();
  if (!ctx) throw new Error('Load the scan with the prep first');
  return ctx;
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

export const frameProposer: Proposer = {
  id: 'classical.frame-seed@1',
  step: 'frame',
  async run({ seed }) {
    if (!seed) throw new Error('Click the prep first');
    const ctx = requireContext();
    const { warnings, ...frame } = await analysis.estimateFrameUnlatched({
      jawSha: ctx.jaw.sha256,
      antagonistSha: ctx.antagonist?.sha256,
      seed,
      fdi: ctx.fdi,
    });
    const ortho = Math.max(
      Math.abs(frame.occlusal[0] * frame.mesial[0] + frame.occlusal[1] * frame.mesial[1] + frame.occlusal[2] * frame.mesial[2]),
      Math.abs(frame.mesial[0] * frame.buccal[0] + frame.mesial[1] * frame.buccal[1] + frame.mesial[2] * frame.buccal[2]),
    );
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
  async run() {
    const ctx = requireContext();
    const frame = ctx.tooth.frame;
    if (!frame) throw new Error('The margin proposer needs a tooth frame');
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
  async run() {
    const ctx = requireContext();
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
  async run() {
    const ctx = requireContext();
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

export const adaptProposer: Proposer = {
  id: 'classical.adapt@1',
  step: 'adapt',
  async run() {
    const ctx = requireContext();
    const { params, frame } = ctx.tooth;
    // A side facing a connected bridge unit has a connector, not a contact.
    const connected = connectedSides(useDesignStore.getState().doc, ctx.fdi);
    const adapt: CrownAdapt = {
      ...(ctx.antagonist ? { occlusion: { clearanceMm: params.occlusalClearanceMm } } : {}),
      ...(frame?.mesialContact && !connected.includes('mesial') ? { mesial: { targetMm: params.proximalContactMm } } : {}),
      ...(frame?.distalContact && !connected.includes('distal') ? { distal: { targetMm: params.proximalContactMm } } : {}),
    };
    const commands: Command[] = [];
    if (adapt.occlusion) commands.push({ type: 'adaptOcclusion', fdi: ctx.fdi, clearanceMm: adapt.occlusion.clearanceMm });
    if (adapt.mesial) commands.push({ type: 'setContact', fdi: ctx.fdi, side: 'mesial', targetMm: adapt.mesial.targetMm });
    if (adapt.distal) commands.push({ type: 'setContact', fdi: ctx.fdi, side: 'distal', targetMm: adapt.distal.targetMm });
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

/** Auto-design pipeline order. */
export const PROPOSERS: readonly Proposer[] = [frameProposer, marginProposer, axisProposer, crownProposer, adaptProposer];

export const proposerForStep = (step: StepId): Proposer | undefined => PROPOSERS.find((p) => p.step === step);


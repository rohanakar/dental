import {
  type Command,
  type CrownAdapt,
  DesignParams,
  type Pose,
  type ToothFrame,
  type CommandOf,
  type DesignDocument,
  downstreamSteps,
  jawOf,
  MATERIAL_PRESETS,
  type ScanRef,
  type StepId,
  type StepStatus,
  type ToothDesign,
} from '@dcad/shared';
import { axisVector, crownCentre, directionVector, movePose, rotatePose, scaleIndex, scalePose, templateHeight } from './clinical';
import { newTooth } from './document';

export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandError';
  }
}

type Steps = Record<StepId, StepStatus>;

/** Mark `step` done and every downstream step that was done as stale. */
function markDone(steps: Steps, step: StepId): Steps {
  const next = { ...steps, [step]: 'done' as const };
  for (const d of downstreamSteps(step)) if (next[d] === 'done') next[d] = 'stale';
  return next;
}

/** Mark `step` and everything downstream of it stale, where they were done. */
function markStaleFrom(steps: Steps, step: StepId): Steps {
  const next = { ...steps };
  for (const d of [step, ...downstreamSteps(step)]) if (next[d] === 'done') next[d] = 'stale';
  return next;
}

function updateTooth(doc: DesignDocument, fdi: number, update: (t: ToothDesign) => ToothDesign): DesignDocument {
  const i = doc.teeth.findIndex((t) => t.fdi === fdi);
  if (i < 0) throw new CommandError(`Tooth ${fdi} is not part of this case`);
  const teeth = doc.teeth.slice();
  teeth[i] = update(teeth[i]!);
  return { ...doc, teeth };
}

const isJawRole = (role: ScanRef['role']) => role === 'upper' || role === 'lower';

/** Re-derive each tooth's `scans` step and invalidate frames when a jaw scan changed. */
function syncScanSteps(doc: DesignDocument, scans: ScanRef[], changedJaw: boolean): DesignDocument {
  const teeth = doc.teeth.map((t) => {
    let steps = changedJaw ? markStaleFrom(t.steps, 'frame') : t.steps;
    const hasJaw = scans.some((s) => s.role === jawOf(t.fdi));
    const scansStatus: StepStatus = hasJaw ? 'done' : 'pending';
    if (steps.scans !== scansStatus) steps = { ...steps, scans: scansStatus };
    return steps === t.steps ? t : { ...t, steps };
  });
  return { ...doc, scans, teeth };
}

/**
 * Apply a clinical edit to the tooth's template-crown pose. Directions and
 * axes come from the tooth frame; the crown must be a library template.
 */
function updateCrownPose(doc: DesignDocument, fdi: number, type: string, edit: (pose: Pose, frame: ToothFrame) => Pose): DesignDocument {
  return updateTooth(doc, fdi, (t) => {
    if (!t.frame) throw new CommandError(`${type}: tooth ${fdi} has no tooth frame yet`);
    if (!t.crown) throw new CommandError(`${type}: tooth ${fdi} has no crown yet`);
    if (t.crown.kind !== 'template') throw new CommandError(`${type}: only library-template crowns can be moved`);
    return { ...t, crown: { ...t.crown, pose: edit(t.crown.pose, t.frame) }, steps: markDone(t.steps, 'proposal') };
  });
}

/** Change a template crown's adaptation targets; the crown is re-derived with them (marks `adapt` done). */
function updateCrownAdapt(doc: DesignDocument, fdi: number, type: string, edit: (adapt: CrownAdapt) => CrownAdapt): DesignDocument {
  return updateTooth(doc, fdi, (t) => {
    if (!t.crown) throw new CommandError(`${type}: tooth ${fdi} has no crown yet`);
    if (t.crown.kind !== 'template') throw new CommandError(`${type}: only library-template crowns can be adapted`);
    return { ...t, crown: { ...t.crown, adapt: edit(t.crown.adapt ?? {}) }, steps: markDone(t.steps, 'adapt') };
  });
}

function setCaseSetup(doc: DesignDocument, cmd: CommandOf<'setCaseSetup'>): DesignDocument {
  const teeth = cmd.setup.teeth.map((order) => {
    const existing = doc.teeth.find((t) => t.fdi === order.fdi);
    if (!existing) return newTooth(order, doc.scans);
    const before = doc.setup.teeth.find((o) => o.fdi === order.fdi);
    if (before && before.material !== order.material) {
      return { ...existing, params: { ...MATERIAL_PRESETS[order.material] }, steps: markStaleFrom(existing.steps, 'params') };
    }
    return existing;
  });
  return { ...doc, setup: cmd.setup, teeth };
}

function addScan(doc: DesignDocument, cmd: CommandOf<'addScan'>): DesignDocument {
  const previous = doc.scans.find((s) => s.role === cmd.scan.role);
  const scans = [...doc.scans.filter((s) => s.role !== cmd.scan.role), cmd.scan];
  const changedJaw = isJawRole(cmd.scan.role) && Boolean(previous) && previous!.mesh.sha256 !== cmd.scan.mesh.sha256;
  return syncScanSteps(doc, scans, changedJaw);
}

function removeScan(doc: DesignDocument, cmd: CommandOf<'removeScan'>): DesignDocument {
  if (!doc.scans.some((s) => s.role === cmd.role)) return doc;
  const scans = doc.scans.filter((s) => s.role !== cmd.role);
  return syncScanSteps(doc, scans, isJawRole(cmd.role));
}

/**
 * Apply one document command. Pure: returns a new document (structural
 * sharing) and never mutates `doc`. Throws CommandError for commands that
 * do not apply to this document.
 */
export function applyCommand(doc: DesignDocument, cmd: Command): DesignDocument {
  switch (cmd.type) {
    case 'setCaseSetup':
      return setCaseSetup(doc, cmd);
    case 'addScan':
      return addScan(doc, cmd);
    case 'removeScan':
      return removeScan(doc, cmd);
    case 'setFrame':
      return updateTooth(doc, cmd.fdi, (t) => ({ ...t, frame: cmd.frame, steps: markDone(t.steps, 'frame') }));
    case 'setMargin':
      return updateTooth(doc, cmd.fdi, (t) => ({ ...t, margin: cmd.margin, steps: markDone(t.steps, 'margin') }));
    case 'setAxis':
      return updateTooth(doc, cmd.fdi, (t) => ({ ...t, axis: cmd.axis, steps: markDone(t.steps, 'axis') }));
    case 'setParams':
      return updateTooth(doc, cmd.fdi, (t) => ({ ...t, params: cmd.params, steps: markDone(t.steps, 'params') }));
    case 'setCrown':
      return updateTooth(doc, cmd.fdi, (t) => ({ ...t, crown: cmd.crown, steps: markDone(t.steps, 'proposal') }));
    case 'moveCrown':
      return updateCrownPose(doc, cmd.fdi, cmd.type, (pose, frame) => movePose(pose, directionVector(frame, cmd.direction), cmd.mm));
    case 'rotateCrown':
      return updateCrownPose(doc, cmd.fdi, cmd.type, (pose, frame) =>
        rotatePose(pose, axisVector(frame, cmd.axis), cmd.deg, crownCentre(pose, templateHeight(cmd.fdi))),
      );
    case 'scaleCrown':
      return updateCrownPose(doc, cmd.fdi, cmd.type, (pose) => scalePose(pose, scaleIndex(cmd.axis), cmd.pct));
    case 'setParam':
      return updateTooth(doc, cmd.fdi, (t) => {
        const params = DesignParams.safeParse({ ...t.params, [cmd.name]: cmd.value });
        if (!params.success) throw new CommandError(`Invalid value ${cmd.value} for ${cmd.name}: ${params.error.issues[0]?.message ?? 'out of range'}`);
        return { ...t, params: params.data, steps: markDone(t.steps, 'params') };
      });
    case 'adaptOcclusion':
      return updateCrownAdapt(doc, cmd.fdi, cmd.type, (a) => ({ ...a, occlusion: { clearanceMm: cmd.clearanceMm } }));
    case 'setContact':
      return updateCrownAdapt(doc, cmd.fdi, cmd.type, (a) => ({ ...a, [cmd.side]: { targetMm: cmd.targetMm } }));
    case 'runStep':
      throw new CommandError(`Command "${cmd.type}" is not supported yet`);
  }
}

export function applyCommands(doc: DesignDocument, cmds: readonly Command[]): DesignDocument {
  return cmds.reduce(applyCommand, doc);
}

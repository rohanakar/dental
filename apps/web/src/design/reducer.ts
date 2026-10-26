import {
  bridgeOf,
  type Command,
  connectedSides,
  type CrownAdapt,
  deriveBridges,
  DesignParams,
  type Pose,
  type ProximalSide,
  type ToothFrame,
  type CommandOf,
  type DesignDocument,
  downstreamSteps,
  jawOf,
  MATERIAL_PRESETS,
  connectionMinAreaMm2,
  MARYLAND_CONNECTOR_MIN_AREA_MM2,
  normalizeConnections,
  pairKey,
  RESTORATION_ROLE,
  type ScanRef,
  sortedPair,
  type StepId,
  type StepStatus,
  type ToothDesign,
  unitKind,
  type UnitKind,
  validateBridges,
} from '@dcad/shared';
import { axisVector, crownCentre, directionVector, movePose, rotatePose, scaleIndex, scalePose, templateHeight } from './clinical';
import { newTooth } from './document';
import { setCutback } from './framework';
import { requireNaturalPrep, setImplant, setScrewChannel, switchSupport, syncEngaging } from './implant';

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
  return updateTeeth(doc, [fdi], update);
}

function updateTeeth(doc: DesignDocument, fdis: readonly number[], update: (t: ToothDesign) => ToothDesign): DesignDocument {
  const teeth = doc.teeth.slice();
  for (const fdi of fdis) {
    const i = teeth.findIndex((t) => t.fdi === fdi);
    if (i < 0) throw new CommandError(`Tooth ${fdi} is not part of this case`);
    teeth[i] = update(teeth[i]!);
  }
  return { ...doc, teeth };
}

// ---- Bridges ------------------------------------------------------------------

/** Pontics have no prep: no margin and no insertion axis. */
function requireAbutment(doc: DesignDocument, fdi: number, type: string): void {
  if (unitKind(doc.setup, fdi) === 'pontic') throw new CommandError(`${type}: ${fdi} is a pontic; it has no margin or insertion axis`);
}

/** The bridge units other than `fdi`, by kind (empty for a single crown). */
function otherUnits(doc: DesignDocument, fdi: number, kind: UnitKind): number[] {
  return (bridgeOf(doc, fdi)?.teeth ?? []).filter((u) => u !== fdi && unitKind(doc.setup, u) === kind);
}

/** Mark `step` and downstream stale on the given units; untouched units keep their identity. */
function staleOn(doc: DesignDocument, fdis: readonly number[], step: StepId): DesignDocument {
  return fdis.length ? updateTeeth(doc, fdis, (t) => ({ ...t, steps: markStaleFrom(t.steps, step) })) : doc;
}

/**
 * An abutment's frame or margin changed: the common axis was computed from the old one, so every other abutment's
 * axis is stale. A frame change also invalidates the pontic frames, which are derived from the neighbouring units.
 */
function invalidateBridge(doc: DesignDocument, fdi: number, changed: 'frame' | 'margin'): DesignDocument {
  if (unitKind(doc.setup, fdi) !== 'abutment') return doc;
  const next = staleOn(doc, otherUnits(doc, fdi, 'abutment'), 'axis');
  return changed === 'frame' ? staleOn(next, otherUnits(doc, fdi, 'pontic'), 'frame') : next;
}

/** A tooth switched between abutment and pontic: its frame is re-derived, and a pontic drops margin and axis. */
function changeKind(tooth: ToothDesign, kind: UnitKind): ToothDesign {
  const steps = markStaleFrom(tooth.steps, 'frame');
  if (kind === 'abutment') return { ...tooth, steps };
  const { margin: _margin, axis: _axis, ...rest } = tooth;
  return { ...rest, steps: { ...steps, margin: 'pending', axis: 'pending' } };
}

/**
 * An abutment switched between a crown and a Maryland wing: a prep margin is not a wing outline (nor the other way
 * round), so the margin and everything after it is redone, and the crown (or the wing's placeholder) goes.
 */
function changeRetainer(tooth: ToothDesign): ToothDesign {
  const { crown: _crown, ...rest } = tooth;
  return { ...rest, steps: { ...markStaleFrom(tooth.steps, 'margin'), proposal: 'pending', adapt: 'pending' } };
}

/**
 * The unit's connected sides changed: a side with a connector has no contact, so its adaptation target goes, and the
 * adaptation is stale (connector and contact geometry changed).
 */
function syncConnectedSides(tooth: ToothDesign, before: readonly ProximalSide[], after: readonly ProximalSide[]): ToothDesign {
  if (before.length === after.length && before.every((s) => after.includes(s))) return tooth;
  const steps = markStaleFrom(tooth.steps, 'adapt');
  const crown = tooth.crown;
  const adapt = crown?.kind === 'template' ? crown.adapt : undefined;
  if (crown?.kind !== 'template' || !adapt || !after.some((s) => adapt[s])) return { ...tooth, steps };
  const free = { ...adapt };
  for (const side of after) delete free[side];
  return { ...tooth, crown: { ...crown, adapt: free }, steps };
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

/**
 * Sync the teeth with a new setup. Bridge setups with validation errors are refused (warnings pass); the bridges are
 * re-derived from the connections, keeping the settings of connectors that still exist.
 */
/**
 * Abutments whose bridge changed its set of abutments (formed, merged, split, a unit joined or switched kind): the
 * common axis must be searched again over the new set, so their axis is stale. Unchanged bridges keep theirs.
 */
function abutmentsWithNewAxisSet(doc: DesignDocument, setup: DesignDocument['setup'], bridges: DesignDocument['bridges']): Set<number> {
  const key = (teeth: readonly number[], s: Pick<DesignDocument['setup'], 'teeth'>) =>
    teeth
      .filter((f) => unitKind(s, f) === 'abutment')
      .sort((x, y) => x - y)
      .join(',');
  const before = (fdi: number) => {
    const bridge = bridgeOf(doc, fdi);
    return bridge ? key(bridge.teeth, doc.setup) : String(fdi);
  };
  const stale = new Set<number>();
  for (const bridge of bridges) {
    const now = key(bridge.teeth, setup);
    const abutments = bridge.teeth.filter((f) => unitKind(setup, f) === 'abutment');
    if (abutments.some((f) => before(f) !== now)) abutments.forEach((f) => stale.add(f));
  }
  return stale;
}

function setCaseSetup(doc: DesignDocument, cmd: CommandOf<'setCaseSetup'>): DesignDocument {
  // Connections to teeth that left the case go with them (removing a bridged tooth must not be refused).
  const inCase = new Set(cmd.setup.teeth.map((t) => t.fdi));
  const connections = normalizeConnections(cmd.setup.connections.filter(([a, b]) => inCase.has(a) && inCase.has(b)));
  const setup = { ...cmd.setup, connections };
  const { errors } = validateBridges(setup);
  if (errors.length) throw new CommandError(`Invalid bridge setup: ${errors.map((e) => e.message).join('; ')}`);
  // A tooth that switched between a crown and a Maryland wing gets its connectors at the new minimum.
  const isWingIn = (s: DesignDocument['setup'], fdi: number) => s.teeth.find((t) => t.fdi === fdi)?.restoration === 'maryland-wing';
  const switched = (fdi: number) => doc.setup.teeth.some((t) => t.fdi === fdi) && isWingIn(doc.setup, fdi) !== isWingIn(setup, fdi);
  const kept = doc.bridges.map((b) => ({ ...b, connectors: b.connectors.filter((c) => !c.between.some(switched)) }));
  const bridges = deriveBridges(setup, kept);
  const axisStale = abutmentsWithNewAxisSet(doc, setup, bridges);
  const teeth = setup.teeth.map((order) => {
    const existing = doc.teeth.find((t) => t.fdi === order.fdi);
    if (!existing) return newTooth(order, doc.scans);
    let tooth = existing;
    const before = doc.setup.teeth.find((o) => o.fdi === order.fdi);
    if (before && before.material !== order.material) {
      tooth = { ...tooth, params: { ...MATERIAL_PRESETS[order.material] }, steps: markStaleFrom(tooth.steps, 'params') };
    }
    const kind = RESTORATION_ROLE[order.restoration].role;
    if (before && RESTORATION_ROLE[before.restoration].role !== kind) tooth = changeKind(tooth, kind);
    else if (before && (before.restoration === 'maryland-wing') !== (order.restoration === 'maryland-wing')) tooth = changeRetainer(tooth);
    if (before) tooth = switchSupport(tooth, before.restoration, order.restoration);
    tooth = syncEngaging(tooth, bridges.some((b) => b.teeth.includes(order.fdi)));
    if (axisStale.has(order.fdi)) tooth = { ...tooth, steps: markStaleFrom(tooth.steps, 'axis') };
    return syncConnectedSides(tooth, connectedSides(doc, order.fdi), connectedSides({ bridges }, order.fdi));
  });
  return { ...doc, setup, teeth, bridges };
}

/**
 * Edit one connector. The area never goes below the material minimum. A connector is derived on top of the adapted
 * units and does not change their surfaces, so editing it (in the Adapt step) leaves their adaptation on.
 */
function setConnector(doc: DesignDocument, cmd: CommandOf<'setConnector'>): DesignDocument {
  const [a, b] = sortedPair(...cmd.between);
  const key = pairKey([a, b]);
  const i = doc.bridges.findIndex((br) => br.connectors.some((c) => pairKey(c.between) === key));
  if (i < 0) throw new CommandError(`${cmd.type}: ${a} and ${b} are not connected`);
  const material = doc.setup.teeth.find((t) => t.fdi === a)!.material;
  const min = connectionMinAreaMm2(doc.setup.teeth, a, b);
  if (cmd.areaMm2 !== undefined && cmd.areaMm2 < min) {
    const which = min === MARYLAND_CONNECTOR_MIN_AREA_MM2 ? 'Maryland' : material;
    throw new CommandError(`${cmd.type}: ${cmd.areaMm2} mm² is below the ${which} minimum of ${min} mm² for ${a}–${b}`);
  }
  const bridges = doc.bridges.slice();
  const bridge = bridges[i]!;
  bridges[i] = {
    ...bridge,
    connectors: bridge.connectors.map((c) =>
      pairKey(c.between) !== key
        ? c
        : {
            ...c,
            areaMm2: cmd.areaMm2 ?? c.areaMm2,
            buccalMm: cmd.buccalMm ?? c.buccalMm,
            occlusalMm: cmd.occlusalMm ?? c.occlusalMm,
          },
    ),
  };
  return { ...doc, bridges };
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
    case 'setFrame': {
      const next = updateTooth(doc, cmd.fdi, (t) => ({ ...t, frame: cmd.frame, steps: markDone(t.steps, 'frame') }));
      return invalidateBridge(next, cmd.fdi, 'frame');
    }
    case 'setMargin': {
      requireAbutment(doc, cmd.fdi, cmd.type);
      requireNaturalPrep(doc, cmd.fdi, cmd.type);
      const next = updateTooth(doc, cmd.fdi, (t) => ({ ...t, margin: cmd.margin, steps: markDone(t.steps, 'margin') }));
      return invalidateBridge(next, cmd.fdi, 'margin');
    }
    case 'setAxis':
      // One common insertion axis: the bridge seats as one piece.
      requireAbutment(doc, cmd.fdi, cmd.type);
      return updateTeeth(doc, [cmd.fdi, ...otherUnits(doc, cmd.fdi, 'abutment')], (t) => ({
        ...t,
        axis: cmd.axis,
        steps: markDone(t.steps, 'axis'),
      }));
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
      if (connectedSides(doc, cmd.fdi).includes(cmd.side)) {
        throw new CommandError(`${cmd.type}: the ${cmd.side} side of ${cmd.fdi} has a connector, not a contact`);
      }
      return updateCrownAdapt(doc, cmd.fdi, cmd.type, (a) => ({ ...a, [cmd.side]: { targetMm: cmd.targetMm } }));
    case 'setConnector':
      return setConnector(doc, cmd);
    case 'setImplant':
      return invalidateBridge(setImplant(doc, cmd, (d, fdi, f) => updateTooth(d, fdi, f), markDone), cmd.fdi, 'margin');
    case 'setScrewChannel':
      return setScrewChannel(doc, cmd, (d, fdi, f) => updateTooth(d, fdi, f), markStaleFrom);
    case 'setCutback':
      return setCutback(doc, cmd, (message) => new CommandError(message));
    case 'runStep':
      throw new CommandError(`Command "${cmd.type}" is not supported yet`);
  }
}

export function applyCommands(doc: DesignDocument, cmds: readonly Command[]): DesignDocument {
  return cmds.reduce(applyCommand, doc);
}

import type { Command, CrownAdapt, ToothDesign } from '@dcad/shared';

const hasTargets = (adapt: CrownAdapt | undefined): adapt is CrownAdapt => Boolean(adapt && (adapt.occlusion || adapt.mesial || adapt.distal));

/**
 * Adaptation targets the derived crown applies: the stored ones, but only
 * while the tooth's adapt step is done. A move, rotation, scale or upstream
 * edit marks the step stale; the crown is then shown un-adapted (what the
 * edit really did) until the designer re-adapts.
 */
export function activeAdapt(tooth: ToothDesign): CrownAdapt | undefined {
  if (tooth.crown?.kind !== 'template' || tooth.steps.adapt !== 'done') return undefined;
  return hasTargets(tooth.crown.adapt) ? tooth.crown.adapt : undefined;
}

/** The crown has adaptation targets that are not applied because a later edit made them stale. */
export function adaptationStale(tooth: ToothDesign): boolean {
  return tooth.crown?.kind === 'template' && hasTargets(tooth.crown.adapt) && tooth.steps.adapt !== 'done';
}

/** Commands that re-apply the stored targets (dispatch as one batch: one undo entry, marks adapt done). */
export function readaptCommands(tooth: ToothDesign): Command[] {
  const adapt = tooth.crown?.kind === 'template' ? tooth.crown.adapt : undefined;
  if (!hasTargets(adapt)) return [];
  const cmds: Command[] = [];
  if (adapt.occlusion) cmds.push({ type: 'adaptOcclusion', fdi: tooth.fdi, clearanceMm: adapt.occlusion.clearanceMm });
  for (const side of ['mesial', 'distal'] as const) {
    const target = adapt[side];
    if (target) cmds.push({ type: 'setContact', fdi: tooth.fdi, side, targetMm: target.targetMm });
  }
  return cmds;
}

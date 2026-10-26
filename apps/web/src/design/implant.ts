import { bridgeOf, isImplantRestoration, type CommandOf, type DesignDocument, type RestorationType, type StepId, type StepStatus, type ToothDesign } from '@dcad/shared';
// Used only inside the rules (never at module load), so the cycle with reducer.ts is harmless.
import { CommandError } from './reducer';

/**
 * Reducer rules for implant crowns (specs/2026-10-25-implant-bridges.md), kept out of reducer.ts so the bridge core
 * stays readable:
 * - the margin step of an implant crown is the "Implant position" step: it holds the scan-body match (setImplant),
 *   never a margin;
 * - setScrewChannel is refused above the library's angled-channel maximum; the restoration is re-derived with the
 *   channel, so Finalize is stale (the placement and the adaptation stay: the channel changes neither);
 * - a single unit sits on an engaging Ti-base, a bridge unit on a non-engaging one (engaging bases cannot seat a
 *   bridge along one path): setImplant refuses the other kind, and a stored implant that no longer fits its unit
 *   (it joined or left a bridge) goes;
 * - a tooth that switches between an implant and a natural support loses the other support's data.
 * The common path over the implant axes is the bridge's common axis (setAxis), unchanged.
 */

type Steps = Record<StepId, StepStatus>;
type Update = (doc: DesignDocument, fdi: number, update: (t: ToothDesign) => ToothDesign) => DesignDocument;


const restorationOf = (doc: DesignDocument, fdi: number): RestorationType | undefined => doc.setup.teeth.find((t) => t.fdi === fdi)?.restoration;
const isImplant = (doc: DesignDocument, fdi: number): boolean => {
  const r = restorationOf(doc, fdi);
  return r !== undefined && isImplantRestoration(r);
};

/** An implant crown has no prepared tooth: its margin step holds the scan-body match. */
export function requireNaturalPrep(doc: DesignDocument, fdi: number, type: string): void {
  if (isImplant(doc, fdi)) throw new CommandError(`${type}: ${fdi} is an implant crown; its position comes from the scan body (setImplant)`);
}

/** Store the scan-body match: the "Implant position" (margin) step is done, everything downstream is stale. */
export function setImplant(doc: DesignDocument, cmd: CommandOf<'setImplant'>, update: Update, markDone: (steps: Steps, step: StepId) => Steps): DesignDocument {
  if (!isImplant(doc, cmd.fdi)) throw new CommandError(`${cmd.type}: ${cmd.fdi} is not an implant crown`);
  const bridged = Boolean(bridgeOf(doc, cmd.fdi));
  if (cmd.implant.engaging === bridged) {
    throw new CommandError(`${cmd.type}: ${bridged ? `${cmd.fdi} is in a bridge: use a non-engaging Ti-base` : `${cmd.fdi} is a single unit: use an engaging Ti-base`}`);
  }
  return update(doc, cmd.fdi, (t) => {
    const { margin: _margin, ...rest } = t;
    // A channel angle the new library does not allow is dropped (straight again).
    const keepChannel = t.screwChannel && t.screwChannel.angleDeg <= cmd.implant.ascMaxDeg;
    const { screwChannel: _channel, ...base } = rest;
    return { ...base, ...(keepChannel ? { screwChannel: t.screwChannel } : {}), implant: cmd.implant, steps: markDone(t.steps, 'margin') };
  });
}

/** The screw channel's angle and azimuth: never above the library maximum; the restoration is re-derived with it. */
export function setScrewChannel(
  doc: DesignDocument,
  cmd: CommandOf<'setScrewChannel'>,
  update: Update,
  markStaleFrom: (steps: Steps, step: StepId) => Steps,
): DesignDocument {
  if (!isImplant(doc, cmd.fdi)) throw new CommandError(`${cmd.type}: ${cmd.fdi} is not an implant crown`);
  return update(doc, cmd.fdi, (t) => {
    if (!t.implant) throw new CommandError(`${cmd.type}: ${cmd.fdi} has no implant position yet`);
    if (cmd.angleDeg > t.implant.ascMaxDeg + 1e-9) {
      throw new CommandError(`${cmd.type}: ${cmd.angleDeg}° is above the ${t.implant.ascMaxDeg}° maximum of the Ti-base library`);
    }
    const azimuthDeg = ((cmd.azimuthDeg % 360) + 360) % 360;
    return { ...t, screwChannel: { angleDeg: cmd.angleDeg, azimuthDeg }, steps: markStaleFrom(t.steps, 'finalize') };
  });
}

/** A stored implant whose Ti-base kind no longer fits the unit (it joined or left a bridge) goes: match it again. */
export function syncEngaging(tooth: ToothDesign, bridged: boolean): ToothDesign {
  if (!tooth.implant || tooth.implant.engaging !== bridged) return tooth;
  const { implant: _implant, screwChannel: _channel, ...rest } = tooth;
  const steps = { ...tooth.steps };
  for (const s of ['axis', 'params', 'proposal', 'adapt', 'finalize'] as const) if (steps[s] === 'done') steps[s] = 'stale';
  return { ...rest, steps: { ...steps, margin: 'pending' } };
}

/**
 * A tooth switched between an implant crown and a crown on a prepared tooth: the other support's data goes (margin,
 * or implant and channel) and the margin step starts again; the axis and everything after it are stale.
 */
export function switchSupport(tooth: ToothDesign, before: RestorationType, after: RestorationType): ToothDesign {
  if (isImplantRestoration(before) === isImplantRestoration(after)) return tooth;
  const { margin: _margin, implant: _implant, screwChannel: _channel, ...rest } = tooth;
  const steps = { ...tooth.steps };
  for (const s of ['axis', 'params', 'proposal', 'adapt', 'finalize'] as const) if (steps[s] === 'done') steps[s] = 'stale';
  return { ...rest, steps: { ...steps, margin: 'pending' } };
}

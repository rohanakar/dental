import { type CommandOf, type Cutback, cutbackOf, type DesignDocument, isReduced } from '@dcad/shared';

/** The cutback a tooth of the document is designed with: undefined unless it is a reduced unit (stable identity). */
export function cutbackFor(doc: DesignDocument, fdi: number): Cutback | undefined {
  const tooth = doc.teeth.find((t) => t.fdi === fdi);
  return tooth ? cutbackOf(doc.setup, tooth) : undefined;
}

/**
 * Edit how a reduced unit is cut back (specs/2026-10-25-framework-bridges.md). The cutback is derived on top of the
 * adapted anatomy, like a connector, so it leaves every step as it is: marking the adaptation stale would switch it
 * off while the cutback is edited in the Adapt step. `fail` builds the reducer's CommandError.
 */
export function setCutback(doc: DesignDocument, cmd: CommandOf<'setCutback'>, fail: (message: string) => Error): DesignDocument {
  const order = doc.setup.teeth.find((t) => t.fdi === cmd.fdi);
  const i = doc.teeth.findIndex((t) => t.fdi === cmd.fdi);
  if (!order || i < 0) throw fail(`Tooth ${cmd.fdi} is not part of this case`);
  if (!isReduced(order.restoration)) throw fail(`${cmd.type}: ${cmd.fdi} is an anatomic ${order.restoration}; switch it to reduced first`);
  const tooth = doc.teeth[i]!;
  const current = cutbackOf(doc.setup, tooth)!;
  const cutback = {
    mode: cmd.mode ?? current.mode,
    thicknessMm: cmd.thicknessMm ?? current.thicknessMm,
    collarMm: cmd.collarMm ?? current.collarMm,
    overpress: cmd.overpress ?? current.overpress,
  };
  const teeth = doc.teeth.slice();
  teeth[i] = { ...tooth, cutback };
  return { ...doc, teeth };
}

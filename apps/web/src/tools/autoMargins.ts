import { type Command, jawOf, type StepId, unitKind } from '@dcad/shared';
import { marginProposer } from '../ai/proposers';
import { MARGIN_DOUBT_CHECK, passed } from '../ai/qa';
import { useDesignStore } from '../design/store';
import { sceneController } from '../state/sceneController';
import { isStale } from '../workers/latestWins';
import { errorText } from './context';
import { useToolStore } from './toolStore';

/**
 * Margins ready for review (specs/2026-10-26-bridge-out-of-the-box.md). On the steps that need a margin (Margin,
 * Insertion axis, Crown proposal), every crown-prep tooth with a frame and no margin (bridge abutments and single
 * crowns alike) gets the automatic margin: the margin proposer's line, set only when it passes its checks, all in one
 * undo step. A tooth whose margin fails is named with the failing check, to trace by hand. Each tooth is tried once
 * per jaw scan and frame, so an undone margin is not put back and a new frame allows a new try. Off with auto frames
 * (browser scripts that trace margins by hand), and while an auto-design draft is open.
 */
const tried = new Set<string>();
let running = false;

const NEEDS_MARGIN: readonly StepId[] = ['margin', 'axis', 'proposal'];

const keyOf = (fdi: number) => {
  const { doc } = useDesignStore.getState();
  const frame = doc.teeth.find((t) => t.fdi === fdi)?.frame;
  const jaw = sceneController.geometryFor(jawOf(fdi));
  return jaw && frame ? `${jaw.sha256}:${fdi}:${frame.origin.map((x) => x.toFixed(3)).join(',')}` : null;
};

/** The case's crown-prep teeth on a loaded jaw that have a frame but no margin (all of them with `all`). */
export function teethWithoutMargin(all = false): number[] {
  const { doc } = useDesignStore.getState();
  return doc.setup.teeth
    .map((t) => t.fdi)
    .filter((fdi) => {
      const tooth = doc.teeth.find((t) => t.fdi === fdi);
      // A pontic has no prep (the margin proposer's own filter leaves that to the bridge plan).
      const prep = unitKind(doc.setup, fdi) !== 'pontic' && marginProposer.appliesTo?.(doc, fdi);
      return Boolean(prep && tooth?.frame && (all || !tooth.margin) && sceneController.geometryFor(jawOf(fdi)));
    });
}

export function autoMargins(): void {
  const tools = useToolStore.getState();
  const { activeStep, transaction } = useDesignStore.getState();
  // Not gated on `busy` (entering Margin analyses the surface): nothing would call this again once it clears, and the
  // worker queues the requests anyway.
  if (running || transaction || !tools.autoFrames || !NEEDS_MARGIN.includes(activeStep)) return;
  const teeth = teethWithoutMargin().filter((fdi) => {
    const key = keyOf(fdi);
    if (!key || tried.has(key)) return false;
    tried.add(key);
    return true;
  });
  if (teeth.length > 0) void findMargins(teeth);
}

/**
 * Find the margins of `teeth` (the Margin step's "Find all margins", and the automatic pass): one undo step for every
 * margin that passes its checks, or fails only the doubt check (named, to check its marked parts); the others are named.
 */
export async function findMargins(teeth: number[]): Promise<void> {
  if (running || teeth.length === 0) return;
  running = true;
  const tools = useToolStore.getState();
  tools.set({ busy: teeth.length === 1 ? `Finding the margin of ${teeth[0]}…` : `Finding the margins of ${teeth.join(', ')}…` });
  try {
    const cmds: Command[] = [];
    const found: number[] = [];
    const doubtful: number[] = [];
    const failed: string[] = [];
    for (const fdi of teeth) {
      // One tooth's failure (no ridge found) does not stop the others.
      try {
        const proposal = await marginProposer.run({ fdi });
        const bad = proposal.qa.find((c) => !c.passed);
        // A line whose only failure is a doubtful stretch is kept, to check where the Margin step marks it.
        const onlyDoubt = !passed(proposal.qa) && proposal.qa.every((c) => c.passed || c.id === MARGIN_DOUBT_CHECK);
        if (passed(proposal.qa) || onlyDoubt) {
          cmds.push(...proposal.output.commands);
          (onlyDoubt ? doubtful : found).push(fdi);
        } else failed.push(`${fdi}: ${bad ? bad.message.toLowerCase() : 'its checks failed'}`);
      } catch (e) {
        if (isStale(e)) throw e;
        failed.push(`${fdi}: ${errorText(e).toLowerCase()}`);
      }
    }
    // Not into a draft opened meanwhile.
    if (cmds.length > 0 && !useDesignStore.getState().transaction) useDesignStore.getState().dispatch(cmds);
    const list = (xs: number[]) => (xs.length === 1 ? `${xs[0]}` : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
    const parts = [
      found.length ? `${found.length === 1 ? 'Margin' : 'Margins'} found for ${list(found)}: check ${found.length === 1 ? 'it' : 'them'}, drag a point to adjust.` : '',
      doubtful.length ? `Found for ${list(doubtful)}, but a stronger edge runs beside part of ${doubtful.length === 1 ? 'it' : 'them'}: check the marked parts.` : '',
      failed.length ? `Not found cleanly, trace by hand: ${failed.join('; ')}.` : '',
    ].filter(Boolean);
    tools.set({ message: { kind: failed.length || doubtful.length ? 'warning' : 'info', text: parts.join(' ') } });
  } catch (e) {
    if (!isStale(e)) tools.set({ message: { kind: 'warning', text: `The margins could not be found: ${errorText(e)}. Trace them by hand.` } });
  } finally {
    running = false;
    useToolStore.getState().set({ busy: null });
  }
}

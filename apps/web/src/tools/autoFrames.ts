import { bridgesOf, type Command, jawOf, unitKind } from '@dcad/shared';
import { applyCommands } from '../design/reducer';
import { useDesignStore } from '../design/store';
import { prepFor } from '../geometry/prepFinder';
import { analysis } from '../workers/geometryClient';
import { isStale } from '../workers/latestWins';
import { errorText, toothContext } from './context';
import { demoPrep } from './demoPrep';
import { bridgeFramesRequest } from './frameTool';
import { activeFinding } from './prepRing';
import { useToolStore, type V3 } from './toolStore';

/**
 * Tooth frames ready for review (specs/2026-10-26-auto-frames.md). Case setup names the teeth and the prep finder
 * pairs each crown-prep tooth with its prep, so on the Tooth frame step every such tooth of the jaw that has no frame
 * gets one from its prep, and a bridge whose abutments are all framed gets its pontics placed: one undo step. Each
 * tooth is tried once per jaw scan, so a frame the user undid or removed is not put back (its ring shows instead).
 */
const tried = new Set<string>();
let running = false;

export function autoFrames(): void {
  if (running || !useToolStore.getState().autoFrames) return;
  const ctx = toothContext();
  const active = activeFinding();
  if (!ctx || !active) return;
  const { doc } = useDesignStore.getState();
  const demo = demoPrep();
  const seeds = active.teeth.flatMap((fdi): Array<{ fdi: number; seed: V3 }> => {
    const key = `${ctx.jaw.sha256}:${fdi}`;
    if (tried.has(key) || doc.teeth.find((t) => t.fdi === fdi)?.frame) return [];
    const seed = demo && fdi === ctx.fdi ? demo : prepFor(active.finding, fdi, active.teeth)?.top;
    if (!seed) return [];
    tried.add(key);
    return [{ fdi, seed }];
  });
  if (seeds.length > 0) void frameFromPreps(ctx.jaw.sha256, ctx.antagonist?.sha256, seeds);
}

async function frameFromPreps(jawSha: string, antagonistSha: string | undefined, seeds: Array<{ fdi: number; seed: V3 }>): Promise<void> {
  running = true;
  const tools = useToolStore.getState();
  tools.set({ busy: 'Setting the frames from the preps found…' });
  try {
    const cmds: Command[] = [];
    // One at a time: the worker call is latest-wins, so a click meanwhile supersedes this run (isStale below).
    for (const { fdi, seed } of seeds) {
      const { warnings: _w, ...frame } = await analysis.estimateFrame({ jawSha, antagonistSha, seed, fdi, prep: true });
      cmds.push({ type: 'setFrame', fdi, frame: { ...frame, source: 'auto' } });
    }
    // A bridge whose abutments are all framed now gets its pontics laid out on the arch between them.
    const framed = applyCommands(useDesignStore.getState().doc, cmds);
    const pontics: number[] = [];
    for (const bridge of bridgesOf(framed.setup)) {
      const units = bridge.filter((f) => jawOf(f) === jawOf(seeds[0]!.fdi));
      const unplaced = units.filter((f) => unitKind(framed.setup, f) === 'pontic' && !framed.teeth.find((t) => t.fdi === f)?.frame);
      const request = unplaced.length > 0 && seeds.some((s) => units.includes(s.fdi)) ? bridgeFramesRequest(framed, units[0]!) : null;
      if (!request) continue;
      const layout = await analysis.bridgeFrames(request);
      for (const p of layout.pontics.filter((p) => unplaced.includes(p.fdi))) {
        cmds.push({ type: 'setFrame', fdi: p.fdi, frame: { ...p.frame, source: 'auto' } });
        pontics.push(p.fdi);
      }
    }
    // A tooth framed by a click meanwhile keeps the user's frame.
    const now = useDesignStore.getState().doc;
    const fresh = cmds.filter((c) => c.type === 'setFrame' && !now.teeth.find((t) => t.fdi === c.fdi)?.frame);
    if (fresh.length === 0) return;
    useDesignStore.getState().dispatch(fresh);
    const teeth = seeds.map((s) => s.fdi).filter((f) => fresh.some((c) => c.type === 'setFrame' && c.fdi === f));
    const placed = pontics.filter((f) => fresh.some((c) => c.type === 'setFrame' && c.fdi === f));
    const list = [...teeth.map(String), ...(placed.length ? [`pontic${placed.length > 1 ? 's' : ''} ${placed.join(', ')}`] : [])].join(', ');
    const one = teeth.length + placed.length === 1;
    const text = one ? `Frame set from the prep found: ${list}. Check it, or click the prep to redo it.` : `Frames set from the preps found: ${list}. Check them, or click a prep to redo one.`;
    tools.set({ message: { kind: 'info', text } });
  } catch (e) {
    if (!isStale(e)) tools.set({ message: { kind: 'warning', text: `The frames could not be set from the preps: ${errorText(e)}. Click each prep instead.` } });
  } finally {
    running = false;
    useToolStore.getState().set({ busy: null });
  }
}

import { bridgesOf, type Command, jawOf, unitKind } from '@dcad/shared';
import { applyCommands } from '../design/reducer';
import { useDesignStore } from '../design/store';
import { prepFor, scanBodyFor } from '../geometry/prepFinder';
import { sceneController } from '../state/sceneController';
import { analysis } from '../workers/geometryClient';
import { isStale } from '../workers/latestWins';
import { errorText } from './context';
import { demoPrep } from './demoPrep';
import { bridgeFramesRequest } from './frameTool';
import { jawFinding } from './prepRing';
import { useToolStore, type V3 } from './toolStore';

/**
 * Tooth frames ready for review (specs/2026-10-26-auto-frames.md, 2026-10-26-auto-frames-jaws-implants.md,
 * 2026-10-26-frames-from-case-setup.md). Case setup names the teeth and the prep finder pairs each crown-prep tooth
 * with its prep and each implant tooth with its scan body. As soon as a jaw scan is in (on any step), every such tooth
 * of every loaded jaw that has no frame gets one, and a bridge whose abutments are all framed gets its pontics placed:
 * one undo step. Each tooth is tried once per jaw scan and kind, so a frame the user undid or removed is not put back
 * (a prep's ring shows instead); a tooth whose restoration switches between a prep crown and an implant crown is
 * framed again from the other finder. Teeth that could not be framed are named once.
 */
const tried = new Set<string>();
/** The frames this pass set, by tooth: from a prep or a scan body, and where (to tell them from a user's frame). */
const setByUs = new Map<number, { prep: boolean; origin: readonly number[] }>();
/** The unframed-teeth notices already shown. */
const named = new Set<string>();
let running = false;

interface Seed {
  fdi: number;
  seed: V3;
  /** A crown prep (its frame follows the prep's axis on a front tooth); false for a scan body, as for its click. */
  prep: boolean;
  jawSha: string;
  antagonistSha?: string;
}

const sameOrigin = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) < 1e-6;

export function autoFrames(): void {
  const { doc, activeFdi, transaction } = useDesignStore.getState();
  // Not while an auto-design draft (or any other transaction) is open: the frames would join it.
  if (running || transaction || !useToolStore.getState().autoFrames) return;
  const jaws = (['lower', 'upper'] as const).map(jawFinding);
  // Every jaw's finding first, so all the frames go out as one undo step.
  if (jaws.includes('pending')) return;
  const demo = demoPrep();
  const seeds: Seed[] = [];
  const unframed: number[] = [];
  for (const jaw of jaws) {
    if (!jaw || jaw === 'pending') continue;
    const sites = [
      ...jaw.preps.map((fdi) => ({ fdi, prep: true, top: demo && fdi === activeFdi ? demo : prepFor(jaw.finding, fdi, jaw.preps)?.top })),
      ...jaw.implants.map((fdi) => ({ fdi, prep: false, top: scanBodyFor(jaw.finding, fdi, jaw.implants)?.top })),
    ];
    for (const { fdi, prep, top } of sites) {
      const frame = doc.teeth.find((t) => t.fdi === fdi)?.frame;
      // A frame this pass set from the other kind of site (the restoration changed since) counts as no frame.
      const ours = setByUs.get(fdi);
      const outdated = frame && ours && ours.prep !== prep && sameOrigin(ours.origin, frame.origin);
      if (frame && !outdated) continue;
      if (!top) {
        unframed.push(fdi);
        continue;
      }
      const key = `${jaw.jawSha}:${fdi}:${prep ? 'prep' : 'scan body'}`;
      if (tried.has(key)) continue;
      tried.add(key);
      seeds.push({ fdi, seed: top, prep, jawSha: jaw.jawSha, ...(jaw.antagonistSha ? { antagonistSha: jaw.antagonistSha } : {}) });
    }
  }
  if (seeds.length > 0) void frameFromFindings(seeds);
  else nameUnframed(unframed);
}

/**
 * Say once which case teeth on a loaded jaw could not be framed (no prep or scan body found, or a count that does not
 * pair), so the user knows where to click. Maryland wings and inlays or onlays are always framed by a click.
 */
function nameUnframed(unframed: number[]): void {
  const { doc } = useDesignStore.getState();
  const loaded = (fdi: number) => Boolean(sceneController.geometryFor(jawOf(fdi)));
  const clickOnly = doc.setup.teeth
    .filter((t) => (t.restoration === 'maryland-wing' || t.restoration === 'inlay' || t.restoration === 'onlay') && loaded(t.fdi) && !doc.teeth.find((x) => x.fdi === t.fdi)?.frame)
    .map((t) => t.fdi);
  const teeth = [...new Set([...unframed, ...clickOnly])].sort((a, b) => a - b);
  if (teeth.length === 0) return;
  const key = teeth.join(',');
  if (named.has(key)) return;
  named.add(key);
  const list = teeth.length === 1 ? `${teeth[0]}` : `${teeth.slice(0, -1).join(', ')} and ${teeth.at(-1)}`;
  // After the edit that caused it has settled: adding a tooth also makes it active, which clears the status line.
  setTimeout(() => {
    if (teeth.every((f) => !useDesignStore.getState().doc.teeth.find((t) => t.fdi === f)?.frame)) {
      useToolStore.getState().set({ message: { kind: 'info', text: `No frame for ${list} yet: click ${teeth.length === 1 ? 'it' : 'each'} on Tooth frame.` } });
    }
  }, 0);
}

async function frameFromFindings(seeds: Seed[]): Promise<void> {
  running = true;
  const tools = useToolStore.getState();
  const implants = seeds.filter((s) => !s.prep).length;
  const source = implants === 0 ? 'preps' : implants === seeds.length ? 'scan bodies' : 'preps and scan bodies';
  tools.set({ busy: `Setting the frames from the ${source} found…` });
  try {
    const cmds: Command[] = [];
    // One at a time: the worker call is latest-wins, so a click meanwhile supersedes this run (isStale below).
    for (const { fdi, seed, prep, jawSha, antagonistSha } of seeds) {
      const { warnings: _w, ...frame } = await analysis.estimateFrame({ jawSha, antagonistSha, seed, fdi, prep });
      cmds.push({ type: 'setFrame', fdi, frame: { ...frame, source: 'auto' } });
    }
    // A bridge whose abutments are all framed now gets its pontics laid out on the arch between them.
    const framed = applyCommands(useDesignStore.getState().doc, cmds);
    const pontics: number[] = [];
    for (const units of bridgesOf(framed.setup)) {
      const unplaced = units.filter((f) => unitKind(framed.setup, f) === 'pontic' && !framed.teeth.find((t) => t.fdi === f)?.frame);
      const request = unplaced.length > 0 && seeds.some((s) => units.includes(s.fdi)) ? bridgeFramesRequest(framed, units[0]!) : null;
      if (!request) continue;
      const layout = await analysis.bridgeFrames(request);
      for (const p of layout.pontics.filter((p) => unplaced.includes(p.fdi))) {
        cmds.push({ type: 'setFrame', fdi: p.fdi, frame: { ...p.frame, source: 'auto' } });
        pontics.push(p.fdi);
      }
    }
    // A tooth framed by a click meanwhile keeps the user's frame; an outdated frame of ours is replaced.
    const now = useDesignStore.getState().doc;
    const replaceable = (fdi: number) => {
      const frame = now.teeth.find((t) => t.fdi === fdi)?.frame;
      const ours = setByUs.get(fdi);
      return !frame || Boolean(ours && sameOrigin(ours.origin, frame.origin));
    };
    const fresh = cmds.filter((c) => c.type === 'setFrame' && replaceable(c.fdi));
    if (fresh.length === 0 || useDesignStore.getState().transaction) return;
    useDesignStore.getState().dispatch(fresh);
    for (const c of fresh) if (c.type === 'setFrame') setByUs.set(c.fdi, { prep: seeds.find((s) => s.fdi === c.fdi)?.prep ?? true, origin: c.frame.origin });
    const set = (f: number) => fresh.some((c) => c.type === 'setFrame' && c.fdi === f);
    const teeth = seeds.map((s) => s.fdi).filter(set);
    const placed = pontics.filter(set);
    const list = [...teeth.map(String), ...(placed.length ? [`pontic${placed.length > 1 ? 's' : ''} ${placed.join(', ')}`] : [])].join(', ');
    const one = teeth.length + placed.length === 1;
    const what = one ? (implants ? 'scan body' : 'prep') : source;
    const text = one ? `Frame set from the ${what} found: ${list}. Check it, or click the ${what} to redo it.` : `Frames set from the ${what} found: ${list}. Check them, or click a ${implants === seeds.length ? 'scan body' : 'prep'} to redo one.`;
    tools.set({ message: { kind: 'info', text } });
  } catch (e) {
    if (!isStale(e)) tools.set({ message: { kind: 'warning', text: `The frames could not be set from the ${source} found: ${errorText(e)}. Click each one instead.` } });
  } finally {
    running = false;
    useToolStore.getState().set({ busy: null });
  }
}

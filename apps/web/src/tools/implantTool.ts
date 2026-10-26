import {
  bridgeOf,
  type Command,
  type DesignDocument,
  isImplantRestoration,
  type ScanRole,
  type StepId,
  type ToothDesign,
  unitKind,
} from '@dcad/shared';
import { BufferAttribute, BufferGeometry, CylinderGeometry, Matrix4, Quaternion, Vector3 } from 'three';
import { create } from 'zustand';
import { exposeForDebug } from '../debug';
import { activeAdapt } from '../design/adaptation';
import { useDesignStore } from '../design/store';
import type { InteractionHandler, Viewer } from '../engine/Viewer';
import type {
  CrownMapName,
  CrownRequest,
  CrownResult,
  ImplantEntryView,
  ImplantPathView,
  ImplantResultView,
  ImplantUnitRequest,
  ScanBodyResult,
} from '../workers/analysisTypes';
import { analysis } from '../workers/geometryClient';
import { isStale } from '../workers/latestWins';
import { errorText, toothContext, type ToothContext } from './context';

/**
 * Implant crowns in the editor (specs/2026-10-25-implant-bridges.md):
 * - Implant position step (the margin step of an implant crown): a click on the scan body's top runs the scan-body
 *   match in the worker; the matched library scan body is shown as a ghost with its fit; Accept stores it
 *   (setImplant) with the tooth frame moved onto the gingival opening, and for a single unit the implant axis as the
 *   insertion axis.
 * - Axis step: a single unit uses its implant axis; a bridge searches the common path over its implant axes.
 * - Proposal and Adapt: the screw channel is drawn (a translucent cylinder and its axis), set by angle and azimuth or
 *   by the auto-angle (classical.screw-channel).
 * Requests for implant units are built here; crownTool and bridgeTool call these hooks.
 */

type V3 = [number, number, number];
const v3 = (p: readonly number[]): V3 => [p[0]!, p[1]!, p[2]!];

const GHOST_ID = 'implant:scan-body';
const CHANNEL_ID = 'implant:channel';
const CHANNEL_AXIS = 'implant:channel-axis';
const IMPLANT_AXIS = 'implant:axis';
const CHANNEL_COLOR = '#d97706';
const IMPLANT_COLOR = '#0f766e';
/** Steps that show the screw channel. */
const CHANNEL_STEPS: readonly StepId[] = ['proposal', 'adapt', 'finalize'];

/** The tooth is an implant crown (its restoration type). */
export const isImplantTooth = (doc: Pick<DesignDocument, 'setup'>, fdi: number): boolean => {
  const order = doc.setup.teeth.find((t) => t.fdi === fdi);
  return Boolean(order && isImplantRestoration(order.restoration));
};

/** A stored implant unit as the worker takes it (ToothDesign.implant and screwChannel), or undefined. */
export function implantRequestOf(tooth: Pick<ToothDesign, 'implant' | 'screwChannel'>): ImplantUnitRequest | undefined {
  const implant = tooth.implant;
  if (!implant) return undefined;
  return { libraryId: implant.libraryId, pose: implant.scanBodyPose, ...(tooth.screwChannel ? { channel: tooth.screwChannel } : {}) };
}

/** crownTool's request for a single implant crown (null until the frame, implant position and axis exist). */
export function implantCrownRequest(ctx: ToothContext, withPose: boolean, map: CrownMapName | 'none'): CrownRequest | null {
  const { frame, axis, params, crown } = ctx.tooth;
  const implant = implantRequestOf(ctx.tooth);
  if (!frame || !axis || !implant) return null;
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
    margin: new Float32Array(0),
    axis: v3(axis.direction),
    params,
    pose: withPose && crown?.kind === 'template' ? crown.pose : undefined,
    maps: map === 'none' ? undefined : [map],
    adapt: withPose ? activeAdapt(ctx.tooth) : undefined,
    implant,
  };
}

/** What a bridge still needs from its implant units (scan-body matches), or null. */
export function implantMissing(doc: DesignDocument, abutments: readonly ToothDesign[]): string | null {
  const unmatched = abutments.filter((t) => isImplantTooth(doc, t.fdi) && !t.implant).map((t) => t.fdi);
  return unmatched.length ? `Match the scan body on ${unmatched.join(', ')} (Implant position).` : null;
}

/** The library entry a unit uses: its stored one, else engaging for a single unit, non-engaging in a bridge. */
export function entryFor(doc: DesignDocument, fdi: number, library: readonly ImplantEntryView[]): ImplantEntryView | undefined {
  const stored = doc.teeth.find((t) => t.fdi === fdi)?.implant?.libraryId;
  if (stored) return library.find((e) => e.key === stored) ?? library[0];
  const engaging = !bridgeOf(doc, fdi);
  return library.find((e) => e.engaging === engaging) ?? library[0];
}

export interface ImplantViewState {
  library: ImplantEntryView[] | null;
  /** The library entry chosen for the next match. */
  entryKey: string | null;
  /** The last match on the active tooth, waiting to be accepted (or the one just accepted). */
  match: { fdi: number; libraryId: string; result: ScanBodyResult; accepted: boolean } | null;
  matching: boolean;
  error: string | null;
  /** The last common-path search of the active bridge. */
  path: ImplantPathView | null;
  /** The active unit's implant result (screw channel, Ti-base fit), from the displayed crown or bridge. */
  result: ImplantResultView | null;
  channelBusy: boolean;
}

export const useImplantStore = create<ImplantViewState>()(() => ({
  library: null,
  entryKey: null,
  match: null,
  matching: false,
  error: null,
  path: null,
  result: null,
  channelBusy: false,
}));
const setStore = (patch: Partial<ImplantViewState>) => useImplantStore.setState(patch);
exposeForDebug('implant', useImplantStore);

class ImplantTool {
  private viewer: Viewer | null = null;
  private ghostFor: unknown = null;
  private channelFor: unknown = null;

  attach(viewer: Viewer | null): void {
    this.viewer = viewer;
    this.ghostFor = null;
    this.channelFor = null;
  }

  /** The synthetic library (from the worker, once). */
  async loadLibrary(): Promise<ImplantEntryView[]> {
    const have = useImplantStore.getState().library;
    if (have) return have;
    const library = await analysis.implantLibrary();
    setStore({ library });
    return library;
  }

  setEntry(key: string): void {
    setStore({ entryKey: key });
  }

  /** Implant position step: a click on the scan body's top runs the match. */
  interaction(jawRole: ScanRole): InteractionHandler {
    return {
      targets: () => [jawRole],
      cursor: 'crosshair',
      onClick: (hit) => {
        if (hit) void this.match([hit.point.x, hit.point.y, hit.point.z]);
      },
    };
  }

  /** Match the library scan body at a click (shown as a ghost; Accept stores it). */
  async match(click: V3): Promise<ScanBodyResult | null> {
    const ctx = toothContext();
    if (!ctx) return null;
    const { doc } = useDesignStore.getState();
    const library = await this.loadLibrary();
    const chosen = useImplantStore.getState().entryKey;
    const entry = (chosen && library.find((e) => e.key === chosen)) || entryFor(doc, ctx.fdi, library);
    if (!entry) return null;
    const frame = ctx.tooth.frame;
    setStore({ matching: true, error: null });
    try {
      const result = await analysis.registerScanBody({
        jawSha: ctx.jaw.sha256,
        fdi: ctx.fdi,
        click,
        libraryId: entry.key,
        ...(frame
          ? {
              frame: {
                origin: v3(frame.origin),
                occlusal: v3(frame.occlusal),
                mesial: v3(frame.mesial),
                buccal: v3(frame.buccal),
                ...(frame.mesialContact ? { mesialContact: v3(frame.mesialContact) } : {}),
                ...(frame.distalContact ? { distalContact: v3(frame.distalContact) } : {}),
              },
            }
          : {}),
      });
      setStore({ match: { fdi: ctx.fdi, libraryId: entry.key, result, accepted: false }, matching: false });
      this.showGhost(result);
      return result;
    } catch (e) {
      if (!isStale(e)) setStore({ matching: false, error: `The scan-body match failed: ${errorText(e)}` });
      return null;
    }
  }

  /**
   * Store the match: the tooth frame on the gingival opening (when the match moved it), the implant (setImplant)
   * and, for a single unit, the implant axis as the insertion axis. One batch, one undo entry.
   */
  accept(): boolean {
    const { match } = useImplantStore.getState();
    const ctx = toothContext();
    if (!match || !ctx || match.fdi !== ctx.fdi) return false;
    const { doc } = useDesignStore.getState();
    const entry = useImplantStore.getState().library?.find((e) => e.key === match.libraryId);
    const r = match.result;
    const cmds: Command[] = [];
    if (r.frame) cmds.push({ type: 'setFrame', fdi: ctx.fdi, frame: { ...r.frame, source: 'auto' } });
    cmds.push({
      type: 'setImplant',
      fdi: ctx.fdi,
      implant: {
        libraryId: match.libraryId,
        scanBodyPose: r.pose,
        engaging: entry?.engaging ?? false,
        ascMaxDeg: entry?.ascMaxDeg ?? 0,
        fit: { rmsMm: r.rmsMm, maxMm: r.maxMm, inlierFraction: r.inlierFraction, coverage: r.coverage },
        source: 'auto',
      },
    });
    if (!bridgeOf(doc, ctx.fdi)) cmds.push({ type: 'setAxis', fdi: ctx.fdi, axis: { direction: r.axis, source: 'auto' } });
    try {
      useDesignStore.getState().dispatch(cmds);
    } catch (e) {
      setStore({ error: errorText(e) });
      return false;
    }
    setStore({ match: { ...match, accepted: true }, error: null });
    return true;
  }

  discard(): void {
    setStore({ match: null, error: null });
    this.hideGhost();
  }

  /** Single unit: the implant axis as the insertion axis. */
  useImplantAxis(): void {
    const ctx = toothContext();
    const pose = ctx?.tooth.implant?.scanBodyPose;
    if (!ctx || !pose) return;
    const axis = new Vector3(0, 0, 1).applyQuaternion(new Quaternion(...pose.quaternion));
    useDesignStore.getState().dispatch({ type: 'setAxis', fdi: ctx.fdi, axis: { direction: [axis.x, axis.y, axis.z], source: 'auto' } });
  }

  /** Bridge: the common path over its implant axes (stored on every abutment by setAxis). */
  async commonPath(): Promise<ImplantPathView | null> {
    const { doc, activeFdi } = useDesignStore.getState();
    const bridge = bridgeOf(doc, activeFdi);
    if (!bridge) return null;
    const implants = bridge.teeth.flatMap((fdi) => {
      const t = doc.teeth.find((x) => x.fdi === fdi);
      return t?.implant ? [{ fdi, pose: t.implant.scanBodyPose, libraryId: t.implant.libraryId }] : [];
    });
    const missing = bridge.teeth.filter((fdi) => unitKind(doc.setup, fdi) === 'abutment' && !implants.some((i) => i.fdi === fdi));
    if (missing.length) {
      setStore({ error: `Match the scan body on ${missing.join(', ')} first.` });
      return null;
    }
    const path = await analysis.implantPath({ implants });
    setStore({ path, error: path.ok ? null : path.failures.join(' ') });
    const target = implants.find((i) => i.fdi === activeFdi) ?? implants[0]!;
    useDesignStore.getState().dispatch({ type: 'setAxis', fdi: target.fdi, axis: { direction: path.direction, source: 'auto' } });
    return path;
  }

  /** Store a screw channel (angle from the implant axis, azimuth from buccal toward mesial). */
  setChannel(angleDeg: number, azimuthDeg: number): void {
    const fdi = useDesignStore.getState().activeFdi;
    try {
      useDesignStore.getState().dispatch({ type: 'setScrewChannel', fdi, angleDeg, azimuthDeg });
    } catch (e) {
      setStore({ error: errorText(e) });
    }
  }

  /** classical.screw-channel: straight if it passes, else the smallest ASC angle with a good exit and wall. */
  async autoChannel(request: CrownRequest | null): Promise<boolean> {
    if (!request?.implant) return false;
    setStore({ channelBusy: true, error: null });
    try {
      const found = await analysis.screwChannelAuto(request);
      if (!found) {
        setStore({ error: 'No channel angle within the library maximum exits occlusally with enough material: the unit cannot be screw-retained as designed.' });
        return false;
      }
      this.setChannel(found.angleDeg, found.azimuthDeg);
      return true;
    } catch (e) {
      setStore({ error: errorText(e) });
      return false;
    } finally {
      setStore({ channelBusy: false });
    }
  }

  /**
   * Called on every store change and after every new crown or bridge result (from the tool controller), with the
   * displayed result of the active unit: the ghost, the implant axis and the screw channel follow them.
   */
  sync(step: StepId, current: CrownResult | null): void {
    const view = current?.implant ?? null;
    if (useImplantStore.getState().result !== view) setStore({ result: view });
    const { doc, activeFdi } = useDesignStore.getState();
    const implant = isImplantTooth(doc, activeFdi);
    const { match } = useImplantStore.getState();
    // The ghost belongs to the implant position step of the tooth it was matched on.
    if (!implant || step !== 'margin' || match?.fdi !== activeFdi) this.hideGhost();
    else if (match && this.ghostFor !== match.result) this.showGhost(match.result);
    if (match && match.fdi !== activeFdi) setStore({ match: null });
    this.drawImplantAxis(implant && (step === 'margin' || step === 'axis') ? doc.teeth.find((t) => t.fdi === activeFdi) : undefined);
    const result = useImplantStore.getState().result;
    if (implant && CHANNEL_STEPS.includes(step) && result) this.showChannel(result);
    else this.hideChannel();
  }

  // ---- display --------------------------------------------------------------------------------------

  private showGhost(result: ScanBodyResult): void {
    const v = this.viewer;
    if (!v) return;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(result.scanBody.positions, 3));
    g.setIndex(new BufferAttribute(result.scanBody.indices, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    v.addObject(GHOST_ID, g, { kind: 'restoration' });
    v.setObjectOpacity(GHOST_ID, 0.55);
    this.ghostFor = result;
  }

  private hideGhost(): void {
    if (this.ghostFor === null) return;
    this.viewer?.removeObject(GHOST_ID);
    this.ghostFor = null;
  }

  private drawImplantAxis(tooth: ToothDesign | undefined): void {
    const o = this.viewer?.overlays;
    if (!o) return;
    const pose = tooth?.implant?.scanBodyPose;
    if (!pose) {
      o.remove(IMPLANT_AXIS);
      return;
    }
    const axis = new Vector3(0, 0, 1).applyQuaternion(new Quaternion(...pose.quaternion));
    o.setArrow(IMPLANT_AXIS, v3(pose.position), [axis.x, axis.y, axis.z], 12, { color: IMPLANT_COLOR, radiusMm: 0.12 });
  }

  private showChannel(result: ImplantResultView): void {
    const v = this.viewer;
    if (!v || this.channelFor === result.channel) return;
    const c = result.channel;
    const length = c.exit ? Math.hypot(c.exit.point[0] - c.pivot[0], c.exit.point[1] - c.pivot[1], c.exit.point[2] - c.pivot[2]) + 1 : 12;
    const g = new CylinderGeometry(c.radiusMm, c.radiusMm, length, 32, 1, true);
    // CylinderGeometry runs along +y from −length/2: move it to start at the pivot along the channel direction.
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(...c.direction));
    const m = new Matrix4().compose(new Vector3(...c.pivot).addScaledVector(new Vector3(...c.direction), length / 2), q, new Vector3(1, 1, 1));
    g.applyMatrix4(m);
    g.computeBoundingSphere();
    v.addObject(CHANNEL_ID, g, { kind: 'restoration' });
    v.setObjectOpacity(CHANNEL_ID, 0.35);
    v.overlays.setArrow(CHANNEL_AXIS, c.pivot, c.direction, length, { color: c.exitOk && c.wallOk ? CHANNEL_COLOR : '#d64545', radiusMm: 0.1 });
    this.channelFor = result.channel;
  }

  private hideChannel(): void {
    if (this.channelFor === null) return;
    this.viewer?.removeObject(CHANNEL_ID);
    this.viewer?.overlays.remove(CHANNEL_AXIS);
    this.channelFor = null;
  }
}

export const implantTool = new ImplantTool();

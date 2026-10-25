import type { ScanRole, StepId } from '@dcad/shared';
import { useDesignStore } from '../design/store';
import type { Viewer } from '../engine/Viewer';
import { sceneController } from '../state/sceneController';
import { useSceneStore } from '../state/sceneStore';
import { analysis } from '../workers/geometryClient';
import { axisTool } from './axisTool';
import { crownTool } from './crownTool';
import { gizmoTool } from './gizmoTool';
import { errorText, toothContext } from './context';
import { focusTool } from './focusTool';
import { frameInteraction } from './frameTool';
import { MARGIN_COLOR, marginTool } from './marginTool';
import { useToolStore } from './toolStore';

export const FRAME_COLORS = { occlusal: '#4c8dff', mesial: '#2fbf71', buccal: '#f0a030', distal: '#a970ff' } as const;
const AXIS_COLOR = '#b07cff';
/** Steps that work on the prep surface: the antagonist is hidden so it does not block the view. */
const HIDE_ANTAGONIST: readonly StepId[] = ['frame', 'margin', 'axis'];
/** Steps after which the accepted margin stays visible. */
const SHOW_MARGIN: readonly StepId[] = ['margin', 'axis'];

function centroid(points: ReadonlyArray<{ p: readonly number[] }>): [number, number, number] {
  const c: [number, number, number] = [0, 0, 0];
  for (const { p } of points) for (let k = 0; k < 3; k++) c[k] = c[k]! + p[k]! / points.length;
  return c;
}

/**
 * Connects the active design step to the viewer: which tool handles pointer
 * input, and which document state (frame, margin, axis) is drawn as
 * overlays. Re-runs on every design-store or scene change.
 */
class DesignTools {
  private viewer: Viewer | null = null;
  private interactionKey = '';
  private lastStep: StepId | null = null;
  private lastFdi: number | null = null;
  private analysedSha: string | null = null;
  /** Antagonist role hidden by HIDE_ANTAGONIST, restored when leaving those steps. */
  private hiddenAntagonist: ScanRole | null = null;
  /** Inputs of the overlays last drawn; overlays are rebuilt only when these change. */
  private drawn: unknown[] = [];

  constructor() {
    useDesignStore.subscribe(() => this.sync());
    useSceneStore.subscribe((s, prev) => {
      if (s.objects !== prev.objects) this.sync();
    });
  }

  attachViewer(viewer: Viewer): void {
    this.viewer = viewer;
    this.interactionKey = '';
    this.drawn = [];
    marginTool.attach(viewer);
    axisTool.attach(viewer);
    crownTool.attach(viewer);
    gizmoTool.attach(viewer);
    focusTool.attach(viewer);
    this.sync();
  }

  detachViewer(viewer: Viewer): void {
    if (this.viewer !== viewer) return;
    this.viewer = null;
    marginTool.attach(null);
    axisTool.attach(null);
    crownTool.attach(null);
    gizmoTool.attach(null);
    focusTool.attach(null);
  }

  /** Store changes made while syncing (e.g. hiding the antagonist) re-trigger sync; run them once more instead of recursing. */
  private syncing = false;
  private resync = false;

  sync(): void {
    if (this.syncing) {
      this.resync = true;
      return;
    }
    this.syncing = true;
    try {
      do {
        this.resync = false;
        this.syncOnce();
      } while (this.resync);
    } finally {
      this.syncing = false;
    }
  }

  private syncOnce(): void {
    const { activeStep: step, activeFdi } = useDesignStore.getState();
    const ctx = toothContext();

    if (this.lastStep !== step || this.lastFdi !== activeFdi) {
      if (this.lastStep === 'margin' || this.lastFdi !== activeFdi) marginTool.cancel();
      if (this.lastStep === 'axis') axisTool.hide();
      if (this.lastStep === 'frame') useToolStore.getState().set({ framePick: 'seed' });
      this.lastStep = step;
      this.lastFdi = activeFdi;
      if (step === 'axis') axisTool.enter();
      if (step === 'margin') this.focusPrep('occlusal');
      if (step === 'axis' || step === 'proposal' || step === 'adapt' || step === 'finalize') this.focusPrep('oblique');
    }
    this.syncAntagonist(step);

    const v = this.viewer;
    if (!v) return;

    const key = ctx ? `${step}:${ctx.jaw.role}` : '';
    if (key !== this.interactionKey) {
      this.interactionKey = key;
      if (ctx && step === 'frame') v.setInteraction(frameInteraction(ctx.jaw.role));
      else if (ctx && step === 'margin') v.setInteraction(marginTool.interaction(ctx.jaw.role));
      else v.setInteraction(null);
    }

    if (ctx && step === 'margin') this.prepareSurface(ctx.jaw.sha256);
    this.drawOverlays(step);
    if (step === 'axis') axisTool.sync();
    crownTool.sync(step);
    gizmoTool.sync(step === 'proposal');
    focusTool.sync();
  }

  /** Zoom onto the prep: from occlusal to trace the margin, obliquely from buccal to judge the axis. */
  private focusPrep(view: 'occlusal' | 'oblique'): void {
    const frame = toothContext()?.tooth.frame;
    if (!frame) return;
    const dir: [number, number, number] =
      view === 'occlusal' ? [...frame.occlusal] : [0, 1, 2].map((k) => frame.occlusal[k]! + 1.2 * frame.buccal[k]!) as [number, number, number];
    this.viewer?.focus(frame.origin, dir, view === 'occlusal' ? 32 : 40);
  }

  private syncAntagonist(step: StepId): void {
    const antagonist = toothContext()?.antagonist?.role ?? null;
    const want = HIDE_ANTAGONIST.includes(step) ? antagonist : null;
    if (want === this.hiddenAntagonist) return;
    // Update the bookkeeping before setVisible: it changes the scene store, which re-enters sync().
    const restore = this.hiddenAntagonist;
    this.hiddenAntagonist = null;
    if (restore) sceneController.setVisible(restore, true);
    const obj = want ? useSceneStore.getState().objects.find((o) => o.id === want) : undefined;
    if (want && obj?.visible) {
      this.hiddenAntagonist = want;
      sceneController.setVisible(want, false);
    }
  }

  /** Warm the worker's adjacency + curvature cache so the first live-wire click is fast. */
  private prepareSurface(sha: string): void {
    if (this.analysedSha === sha) return;
    this.analysedSha = sha;
    const tools = useToolStore.getState();
    tools.set({ surface: 'analysing' });
    analysis
      .analyzeSurface(sha)
      .then(() => {
        if (this.analysedSha === sha) useToolStore.getState().set({ surface: 'ready' });
      })
      .catch((e: unknown) => {
        this.analysedSha = null;
        useToolStore.getState().set({ surface: 'error', message: { kind: 'error', text: `Surface analysis failed: ${errorText(e)}` } });
      });
  }

  private drawOverlays(step: StepId): void {
    const o = this.viewer!.overlays;
    const tooth = toothContext()?.tooth;
    const inputs = [step, tooth?.frame, tooth?.margin, tooth?.axis];
    if (inputs.length === this.drawn.length && inputs.every((x, i) => x === this.drawn[i])) return;
    this.drawn = inputs;

    const frame = tooth?.frame;
    if (frame && step === 'frame') {
      o.setArrow('frame:occlusal', frame.origin, frame.occlusal, 7, { color: FRAME_COLORS.occlusal });
      o.setArrow('frame:mesial', frame.origin, frame.mesial, 6, { color: FRAME_COLORS.mesial });
      o.setArrow('frame:buccal', frame.origin, frame.buccal, 5, { color: FRAME_COLORS.buccal });
      o.setMarkers('frame:origin', [frame.origin], { color: '#ffffff', outline: '#222222', sizePx: 9 });
      if (frame.mesialContact) o.setMarkers('frame:mesial-contact', [frame.mesialContact], { color: FRAME_COLORS.mesial, sizePx: 13 });
      else o.remove('frame:mesial-contact');
      if (frame.distalContact) o.setMarkers('frame:distal-contact', [frame.distalContact], { color: FRAME_COLORS.distal, sizePx: 13 });
      else o.remove('frame:distal-contact');
    } else o.removePrefix('frame:');

    const margin = tooth?.margin;
    if (margin && SHOW_MARGIN.includes(step)) {
      o.setPolyline('margin:line', margin.points.map((m) => m.p), { color: MARGIN_COLOR, widthPx: 3, closed: true });
      if (step === 'margin') o.setMarkers('margin:anchors', margin.anchors.map((a) => a.p), { color: MARGIN_COLOR, sizePx: 11 });
      else o.remove('margin:anchors');
    } else {
      o.remove('margin:line');
      o.remove('margin:anchors');
    }

    const axis = tooth?.axis;
    if (axis && margin && step === 'axis') {
      o.setArrow('axis:arrow', centroid(margin.points), axis.direction, 10, { color: AXIS_COLOR, radiusMm: 0.15 });
    } else o.remove('axis:arrow');
  }
}

export const designTools = new DesignTools();

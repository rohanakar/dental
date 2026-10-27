import { marginProposer } from '../ai/proposers';
import { useDesignStore } from '../design/store';
import type { InteractionHandler, Viewer, ViewerHit } from '../engine/Viewer';
import { pathFromTree } from '../geometry/livewire';
import { redrawSection } from '../geometry/marginEdit';
import { analysis } from '../workers/geometryClient';
import { isStale } from '../workers/latestWins';
import { errorText, fromMarginPoints, nearestCorner, pathPositions, toMarginPoints, toothContext } from './context';
import { marginLineOf } from './marginLine';
import { useToolStore, type MarginAnchor, type V3 } from './toolStore';

/** Screen distance (CSS px) within which a click closes the loop or grabs an anchor. */
const SNAP_PX = 10;
/** Live-wire search radius used by the worker; paths beyond it need an intermediate click. */
const TOO_FAR_TEXT = 'That point is too far from the previous anchor. Click a point closer to it first.';
const SECTION_TOO_FAR_TEXT = 'That is too far from the first click. Redraw a shorter section, or two in turn.';

export const MARGIN_COLOR = '#ff4d6d';
const DRAFT_COLOR = '#ffd166';

/**
 * Live-wire margin tool. Each click adds an anchor; the worker computes a
 * bounded shortest-path tree from it (edges along the margin are cheap: convex
 * ridges for a prep's finish line, the concave crease for a natural tooth's gum
 * line), and the main thread looks up the path to the cursor in that tree, so
 * the preview follows the pointer without a worker round trip. Clicking the
 * first anchor (or Enter) closes the loop; the worker then re-traces the
 * whole loop, resamples it and the result becomes a setMargin command.
 *
 * "Redraw a section" (specs/2026-10-27-natural-margin.md): two clicks; the
 * live-wire path between them replaces the part of the line it is closest to,
 * and the rest of the line is kept.
 */
class MarginTool {
  private viewer: Viewer | null = null;
  /** Vertex paths between consecutive draft anchors. */
  private segments: number[][] = [];
  private tree: { source: number; pred: Int32Array } | null = null;
  private treeRequest: Promise<void> | null = null;
  private drag: { index: number; anchors: V3[] } | null = null;

  attach(viewer: Viewer | null): void {
    this.viewer = viewer;
    this.redraw();
  }

  interaction(jawRole: string): InteractionHandler {
    return {
      targets: () => [jawRole],
      cursor: 'crosshair',
      onClick: (hit, e) => void this.click(hit, e),
      onHover: (hit, e) => this.hover(hit, e),
      onDragStart: (e) => this.dragStart(e),
      onDrag: (hit) => this.dragMove(hit),
      onDragEnd: () => void this.dragEnd(),
    };
  }

  /** Drop the in-progress draft or section redraw (Esc, step change, tooth change). */
  cancel(keepMessage = false): void {
    this.segments = [];
    this.tree = null;
    this.treeRequest = null;
    this.drag = null;
    useToolStore.getState().set(keepMessage ? { marginAnchors: [], sectionRedraw: null } : { marginAnchors: [], sectionRedraw: null, message: null });
    this.viewer?.overlays.remove('margin:close-hint');
    this.redraw();
  }

  /** Remove the last draft anchor (Backspace). */
  undoAnchor(): void {
    const anchors = useToolStore.getState().marginAnchors;
    if (anchors.length === 0) return;
    const next = anchors.slice(0, -1);
    this.segments = this.segments.slice(0, Math.max(0, next.length - 1));
    useToolStore.getState().set({ marginAnchors: next, message: null });
    const last = next.at(-1);
    if (last) this.requestTree(last.vertex);
    else this.tree = null;
    this.redraw();
  }

  /** Close the draft loop (Enter or click on the first anchor). */
  async close(): Promise<void> {
    const anchors = useToolStore.getState().marginAnchors;
    if (anchors.length < 3) {
      useToolStore.getState().set({ message: { kind: 'warning', text: 'Place at least 3 points around the prep before closing.' } });
      return;
    }
    if (await this.commit(anchors.map((a) => a.p), 'Tracing the margin…')) this.cancel(true);
  }

  /** Start "Redraw a section": the next click marks where the wrong part starts, the one after where it ends. */
  startSection(): void {
    if (!toothContext()?.tooth.margin) return;
    this.cancel();
    useToolStore.getState().set({ sectionRedraw: { first: null }, message: { kind: 'info', text: 'Click on the line where the wrong part starts.' } });
  }

  /**
   * Find the margin automatically (the margin proposer: the line chosen for this tooth, else its rule) as a plain
   * edit, one undo step. Its failed checks are said in the message.
   */
  async find(): Promise<void> {
    const ctx = toothContext();
    if (!ctx) return;
    this.cancel();
    const tools = useToolStore.getState();
    tools.set({ busy: marginLineOf(ctx.fdi) === 'gum' ? 'Finding the gum line…' : 'Finding the margin…', message: null });
    try {
      const proposal = await marginProposer.run({ fdi: ctx.fdi });
      useDesignStore.getState().dispatch(proposal.output.commands);
      const failed = proposal.qa.filter((c) => !c.passed);
      tools.set({
        message: failed.length
          ? { kind: 'warning', text: `${proposal.rationale ?? ''} Check it: ${failed.map((c) => c.message.toLowerCase()).join('; ')}.` }
          : { kind: 'info', text: proposal.rationale ?? 'Margin found.' },
      });
    } catch (e) {
      if (!isStale(e)) tools.set({ message: { kind: 'error', text: `Could not find the margin: ${errorText(e)}` } });
    } finally {
      tools.set({ busy: null });
    }
  }

  /** Smooth the accepted margin (Laplacian smoothing, re-projected onto the scan). */
  async smooth(iterations = 3): Promise<void> {
    const ctx = toothContext();
    const margin = ctx?.tooth.margin;
    if (!ctx || !margin) return;
    const tools = useToolStore.getState();
    tools.set({ busy: 'Smoothing…' });
    try {
      const points = await analysis.smoothMargin(ctx.jaw.sha256, fromMarginPoints(margin.points), iterations);
      useDesignStore.getState().dispatch({
        type: 'setMargin',
        fdi: ctx.fdi,
        margin: { ...margin, points: toMarginPoints(points), source: 'manual' },
      });
    } catch (e) {
      if (!isStale(e)) tools.set({ message: { kind: 'error', text: `Smoothing failed: ${errorText(e)}` } });
    } finally {
      tools.set({ busy: null });
    }
  }

  /** Draw the draft (anchors, traced segments) and the anchors of an accepted margin. */
  redraw(preview?: Float32Array | null): void {
    const v = this.viewer;
    if (!v) return;
    const ctx = toothContext();
    const anchors = useToolStore.getState().marginAnchors;
    const sectionStart = useToolStore.getState().sectionRedraw?.first;
    if (ctx && sectionStart) {
      v.overlays.remove('margin:draft');
      v.overlays.setMarkers('margin:draft-anchors', [sectionStart.p], { color: DRAFT_COLOR, outline: '#3a2a00', sizePx: 11 });
      if (preview && preview.length >= 6) v.overlays.setPolyline('margin:preview', preview, { color: DRAFT_COLOR, widthPx: 3, depthTest: false, opacity: 0.9 });
      else v.overlays.remove('margin:preview');
    } else if (!ctx || anchors.length === 0) {
      v.overlays.removePrefix('margin:draft');
      v.overlays.remove('margin:preview');
    } else {
      const path = this.segments.flatMap((s, i) => (i === 0 ? s : s.slice(1)));
      if (path.length > 1) v.overlays.setPolyline('margin:draft', pathPositions(ctx.jaw.geometry, path), { color: DRAFT_COLOR, widthPx: 3 });
      else v.overlays.remove('margin:draft');
      v.overlays.setMarkers('margin:draft-anchors', anchors.map((a) => a.p), { color: DRAFT_COLOR, outline: '#3a2a00', sizePx: 11 });
      if (preview && preview.length >= 6) {
        v.overlays.setPolyline('margin:preview', preview, { color: DRAFT_COLOR, widthPx: 2, depthTest: false, opacity: 0.85 });
      } else v.overlays.remove('margin:preview');
    }
    const drag = this.drag;
    if (drag) v.overlays.setMarkers('margin:anchors', drag.anchors, { color: MARGIN_COLOR, sizePx: 11 });
  }

  private requestTree(source: number): void {
    const ctx = toothContext();
    if (!ctx) return;
    this.tree = null;
    const request = analysis
      .liveWireTree(ctx.jaw.sha256, source, marginLineOf(ctx.fdi))
      .then((pred) => {
        if (this.treeRequest === request) this.tree = { source, pred };
      })
      .catch((e: unknown) => {
        if (!isStale(e)) useToolStore.getState().set({ message: { kind: 'error', text: `Live-wire failed: ${errorText(e)}` } });
      });
    this.treeRequest = request;
  }

  private nearFirstAnchor(e: PointerEvent): boolean {
    const first = useToolStore.getState().marginAnchors[0];
    const s = first && this.viewer?.project(first.p);
    return Boolean(s && Math.hypot(s.x - e.clientX, s.y - e.clientY) < SNAP_PX);
  }

  private async click(hit: ViewerHit | null, e: PointerEvent): Promise<void> {
    const ctx = toothContext();
    if (!ctx) return;
    if (useToolStore.getState().sectionRedraw) {
      await this.sectionClick(hit);
      return;
    }
    const tools = useToolStore.getState();
    const anchors = tools.marginAnchors;
    if (anchors.length >= 3 && this.nearFirstAnchor(e)) {
      await this.close();
      return;
    }
    if (!hit || hit.objectId !== ctx.jaw.role) return;
    if (anchors.length === 0 && ctx.tooth.margin) {
      tools.set({ message: { kind: 'info', text: 'Redrawing: the current margin is replaced when the new loop is closed.' } });
    }
    const vertex = nearestCorner(ctx.jaw.geometry, hit.faceIndex, hit.point);
    const anchor: MarginAnchor = { p: [hit.point.x, hit.point.y, hit.point.z], vertex };
    if (anchors.length > 0) {
      await this.treeRequest;
      const path = this.tree ? pathFromTree(this.tree.pred, vertex) : null;
      if (!path || path.length < 2) {
        tools.set({ message: { kind: 'warning', text: TOO_FAR_TEXT } });
        return;
      }
      this.segments.push(path);
    }
    useToolStore.getState().set({ marginAnchors: [...useToolStore.getState().marginAnchors, anchor], message: null });
    this.requestTree(vertex);
    this.redraw();
  }

  /** A click of "Redraw a section": the first marks the start; the second traces to it and splices the path in. */
  private async sectionClick(hit: ViewerHit | null): Promise<void> {
    const ctx = toothContext();
    const margin = ctx?.tooth.margin;
    const tools = useToolStore.getState();
    if (!ctx || !margin || !hit || hit.objectId !== ctx.jaw.role) return;
    const vertex = nearestCorner(ctx.jaw.geometry, hit.faceIndex, hit.point);
    const first = tools.sectionRedraw?.first;
    if (!first) {
      tools.set({ sectionRedraw: { first: { p: [hit.point.x, hit.point.y, hit.point.z], vertex } }, message: { kind: 'info', text: 'Now click where the wrong part ends.' } });
      this.requestTree(vertex);
      this.redraw();
      return;
    }
    await this.treeRequest;
    const path = this.tree ? pathFromTree(this.tree.pred, vertex) : null;
    if (!path || path.length < 2) {
      tools.set({ message: { kind: 'warning', text: SECTION_TOO_FAR_TEXT } });
      return;
    }
    const packed = pathPositions(ctx.jaw.geometry, path);
    const section = Array.from({ length: packed.length / 3 }, (_, i): V3 => [packed[i * 3]!, packed[i * 3 + 1]!, packed[i * 3 + 2]!]);
    try {
      const next = redrawSection({ anchors: margin.anchors.map((a) => [...a.p] as V3), points: margin.points.map((m) => [...m.p] as V3) }, section);
      useDesignStore.getState().dispatch({
        type: 'setMargin',
        fdi: ctx.fdi,
        margin: { ...margin, anchors: next.anchors.map((p) => ({ p })), points: toMarginPoints(new Float32Array(next.points.flat())), source: 'manual' },
      });
      this.cancel(true);
      tools.set({ message: { kind: 'info', text: 'Section redrawn. Redraw another, or carry on.' } });
    } catch (e) {
      tools.set({ message: { kind: 'warning', text: errorText(e) } });
    }
  }

  private hover(hit: ViewerHit | null, e: PointerEvent): void {
    const ctx = toothContext();
    const anchors = useToolStore.getState().marginAnchors;
    if (ctx && useToolStore.getState().sectionRedraw?.first) {
      const path = hit && hit.objectId === ctx.jaw.role && this.tree ? pathFromTree(this.tree.pred, nearestCorner(ctx.jaw.geometry, hit.faceIndex, hit.point)) : null;
      this.redraw(path ? pathPositions(ctx.jaw.geometry, path) : null);
      return;
    }
    if (!ctx || anchors.length === 0) return;
    if (anchors.length >= 3 && this.nearFirstAnchor(e)) {
      this.viewer?.overlays.setMarkers('margin:close-hint', [anchors[0]!.p], { color: '#ffffff', outline: DRAFT_COLOR, sizePx: 16 });
    } else this.viewer?.overlays.remove('margin:close-hint');
    if (!hit || hit.objectId !== ctx.jaw.role || !this.tree) {
      this.redraw(null);
      return;
    }
    const path = pathFromTree(this.tree.pred, nearestCorner(ctx.jaw.geometry, hit.faceIndex, hit.point));
    this.redraw(path ? pathPositions(ctx.jaw.geometry, path) : null);
  }

  private dragStart(e: PointerEvent): boolean {
    const margin = toothContext()?.tooth.margin;
    if (!margin || useToolStore.getState().marginAnchors.length > 0 || useToolStore.getState().sectionRedraw || !this.viewer) return false;
    const anchors = margin.anchors.map((a) => [...a.p] as V3);
    const index = anchors.findIndex((p) => {
      const s = this.viewer!.project(p);
      return s && Math.hypot(s.x - e.clientX, s.y - e.clientY) < SNAP_PX;
    });
    if (index < 0) return false;
    this.drag = { index, anchors };
    return true;
  }

  private dragMove(hit: ViewerHit | null): void {
    const ctx = toothContext();
    if (!this.drag || !ctx || !hit || hit.objectId !== ctx.jaw.role) return;
    this.drag.anchors[this.drag.index] = [hit.point.x, hit.point.y, hit.point.z];
    this.redraw();
  }

  private async dragEnd(): Promise<void> {
    const drag = this.drag;
    if (!drag) return;
    await this.commit(drag.anchors, 'Re-tracing the margin…');
    this.drag = null;
    this.redraw();
  }

  private async commit(anchors: V3[], busy: string): Promise<boolean> {
    const ctx = toothContext();
    if (!ctx) return false;
    const tools = useToolStore.getState();
    tools.set({ busy, message: null });
    try {
      const line = marginLineOf(ctx.fdi);
      const trace = await analysis.traceMargin(ctx.jaw.sha256, anchors, line);
      useDesignStore.getState().dispatch({
        type: 'setMargin',
        fdi: ctx.fdi,
        margin: {
          anchors: anchors.map((p) => ({ p })),
          points: toMarginPoints(trace.points),
          source: 'manual',
          ...(line === 'gum' ? { line } : {}),
        },
      });
      tools.set({ message: { kind: 'info', text: `Margin closed: ${trace.lengthMm.toFixed(1)} mm.` } });
      return true;
    } catch (e) {
      if (!isStale(e)) tools.set({ message: { kind: 'error', text: `Could not trace the margin: ${errorText(e)}` } });
      return false;
    } finally {
      tools.set({ busy: null });
    }
  }
}

export const marginTool = new MarginTool();

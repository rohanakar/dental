import { marginProposer } from '../ai/proposers';
import { gumLineGate } from '../ai/qa';
import { useDesignStore } from '../design/store';
import type { InteractionHandler, Viewer, ViewerHit } from '../engine/Viewer';
import { pathFromTree } from '../geometry/livewire';
import { insertAnchor, redrawSection, replaceArc } from '../geometry/marginEdit';
import { analysis } from '../workers/geometryClient';
import { isStale } from '../workers/latestWins';
import { errorText, fromMarginPoints, nearestCorner, pathPositions, toMarginPoints, toothContext } from './context';
import { marginKey, marginLineOf } from './marginLine';
import { useToolStore, type MarginAnchor, type V3 } from './toolStore';

/** Screen distance (CSS px) within which a click closes the loop or grabs an anchor. */
const SNAP_PX = 10;
/** Screen distance (CSS px) within which a click counts as on the margin line (it adds a point there). */
const ON_LINE_PX = 6;
/** Live-wire search radius used by the worker; paths beyond it need an intermediate click. */
const TOO_FAR_TEXT = 'That point is too far from the previous anchor. Click a point closer to it first.';
const SECTION_TOO_FAR_TEXT = 'That is too far from the first click. Redraw a shorter section, or two in turn.';

export const MARGIN_COLOR = '#ff4d6d';
/** One Lower or Raise of the whole margin (mm along the tooth axis). */
export const OFFSET_STEP_MM = 0.1;
/** The cross-section under the cursor spans this far either side of it (mm). */
const SECTION_HALF_MM = 3;
const MARK_COLORS = { tooth: '#3b82f6', gum: '#ec4899' } as const;
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
 *
 * Editing an accepted line (specs/2026-10-27-margin-review-ux.md): dragging or
 * deleting a point re-traces only between its two neighbours; a click on the
 * line adds a point; the whole line can be raised or lowered; the line is
 * coloured by doubt, and N flies to each doubtful part.
 */
class MarginTool {
  private viewer: Viewer | null = null;
  /** Vertex paths between consecutive draft anchors. */
  private segments: number[][] = [];
  private tree: { source: number; pred: Int32Array } | null = null;
  private treeRequest: Promise<void> | null = null;
  private drag: { index: number; anchors: V3[] } | null = null;
  /** The accepted margin's point under the cursor (Delete removes it), or −1. */
  private hovered = -1;
  /** The brush stroke being painted (gum-line marks), or null. */
  private stroke: V3[] | null = null;
  /** The margin whose doubt is being worked out (its key), so it is asked for once. */
  private doubtKey: string | null = null;

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
    this.stroke = null;
    useToolStore
      .getState()
      .set(keepMessage ? { marginAnchors: [], sectionRedraw: null, scribbleBrush: null } : { marginAnchors: [], sectionRedraw: null, scribbleBrush: null, message: null });
    this.viewer?.overlays.remove('margin:close-hint');
    this.viewer?.overlays.remove('margin:hover');
    this.hovered = -1;
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
      // A doubtful gum line is explained in the Margin step's warning box; a finish line's failed checks are said here.
      const gum = proposal.output.commands.some((c) => c.type === 'setMargin' && c.margin.line === 'gum');
      const failed = gum ? [] : proposal.qa.filter((c) => !c.passed);
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

  /**
   * The cross-section under the cursor (geometry/crossSection.ts): the scan's cut through `p` across the margin, and
   * where the margin crosses it. Latest wins as the cursor moves.
   */
  private requestSection(p: V3): void {
    const ctx = toothContext();
    const frame = ctx?.tooth.frame;
    if (!ctx || !frame || !useToolStore.getState().sectionView) return;
    const up: V3 = [frame.occlusal[0]!, frame.occlusal[1]!, frame.occlusal[2]!];
    const r: V3 = [p[0] - frame.origin[0]!, p[1] - frame.origin[1]!, p[2] - frame.origin[2]!];
    const along = r[0] * up[0] + r[1] * up[1] + r[2] * up[2];
    const flat: V3 = [r[0] - along * up[0], r[1] - along * up[1], r[2] - along * up[2]];
    const len = Math.hypot(...flat);
    const across: V3 = len > 0.5 ? [flat[0] / len, flat[1] / len, flat[2] / len] : [frame.buccal[0]!, frame.buccal[1]!, frame.buccal[2]!];
    const margin = ctx.tooth.margin;
    analysis
      .crossSection(ctx.jaw.sha256, p, up, across, SECTION_HALF_MM)
      .then((segments) => {
        // Where the margin crosses the plane (the normal is up × across), in the section's coordinates.
        const normal: V3 = [up[1] * across[2] - up[2] * across[1], up[2] * across[0] - up[0] * across[2], up[0] * across[1] - up[1] * across[0]];
        const marks: Array<[number, number]> = [];
        const pts = margin?.points ?? [];
        for (let i = 0; i < pts.length; i++) {
          const q0 = pts[i]!.p, q1 = pts[(i + 1) % pts.length]!.p;
          const rel = (q: readonly number[]): V3 => [q[0]! - p[0], q[1]! - p[1], q[2]! - p[2]];
          const d0 = rel(q0), d1 = rel(q1);
          const s0 = d0[0] * normal[0] + d0[1] * normal[1] + d0[2] * normal[2];
          const s1 = d1[0] * normal[0] + d1[1] * normal[1] + d1[2] * normal[2];
          if (s0 > 0 === s1 > 0) continue;
          const t = s0 / (s0 - s1);
          const q: V3 = [d0[0] + t * (d1[0] - d0[0]), d0[1] + t * (d1[1] - d0[1]), d0[2] + t * (d1[2] - d0[2])];
          const s = q[0] * across[0] + q[1] * across[1] + q[2] * across[2];
          const h = q[0] * up[0] + q[1] * up[1] + q[2] * up[2];
          if (Math.abs(s) <= SECTION_HALF_MM && Math.abs(h) <= SECTION_HALF_MM) marks.push([s, h]);
        }
        useToolStore.getState().set({ section: { segments, marks, halfMm: SECTION_HALF_MM } });
      })
      .catch(() => {
        // Superseded by a newer cursor position, or off the scan.
      });
  }

  /** Mark the tooth or the gum (a gum line's scribble correction): drags paint marks, and the line is found again. */
  setBrush(brush: 'tooth' | 'gum' | null): void {
    useToolStore.getState().set({
      scribbleBrush: brush,
      message: brush ? { kind: 'info', text: `Paint on the ${brush} where the line is wrong; the gum line is found again around your marks.` } : null,
    });
  }

  /** Drop the marks of the active tooth. */
  clearMarks(): void {
    useToolStore.getState().set({ scribbles: null });
    this.redraw();
  }

  /** Find the gum line again with the marks as extra seeds (geometry/naturalMargin.ts `marks`). */
  private async solveWithMarks(): Promise<void> {
    const ctx = toothContext();
    const frame = ctx?.tooth.frame;
    const marks = useToolStore.getState().scribbles;
    if (!ctx || !frame || !marks || marks.fdi !== ctx.fdi) return;
    const tools = useToolStore.getState();
    tools.set({ busy: 'Finding the gum line around your marks…', message: null });
    try {
      const v3 = (p: readonly number[]): V3 => [p[0]!, p[1]!, p[2]!];
      const view = await analysis.naturalMargin({
        jawSha: ctx.jaw.sha256,
        frame: { origin: v3(frame.origin), occlusal: v3(frame.occlusal), mesial: v3(frame.mesial), buccal: v3(frame.buccal) },
        fdi: ctx.fdi,
        marks: { tooth: marks.tooth, gum: marks.gum },
      });
      const points = toMarginPoints(view.points);
      useDesignStore.getState().dispatch({ type: 'setMargin', fdi: ctx.fdi, margin: { anchors: view.anchors.map((p) => ({ p })), points, source: 'manual', line: 'gum' } });
      tools.set({
        gumLineChecks: { fdi: ctx.fdi, key: marginKey(points), checks: gumLineGate({ lengthMm: view.lengthMm, agreementMm: view.agreementMm, perimeterRatio: view.perimeterRatio }) },
        message: { kind: 'info', text: 'Gum line found again around your marks. Paint more, or clear the marks.' },
      });
    } catch (e) {
      tools.set({ message: { kind: 'error', text: `Could not find the gum line: ${errorText(e)}` } });
    } finally {
      tools.set({ busy: null });
    }
  }

  /** Work out where the active margin is doubtful (geometry/marginDoubt.ts), unless that is known for its points. */
  ensureDoubt(): void {
    const ctx = toothContext();
    const margin = ctx?.tooth.margin;
    const frame = ctx?.tooth.frame;
    if (!ctx || !margin || !frame || margin.points.length < 8) return;
    const line = marginLineOf(ctx.fdi);
    const key = `${marginKey(margin.points)}:${line}`;
    const known = useToolStore.getState().marginDoubt;
    if ((known?.fdi === ctx.fdi && known.key === key) || this.doubtKey === key) return;
    this.doubtKey = key;
    analysis
      .marginDoubt(ctx.jaw.sha256, fromMarginPoints(margin.points), [frame.occlusal[0]!, frame.occlusal[1]!, frame.occlusal[2]!], line)
      .then((r) => {
        if (this.doubtKey === key) useToolStore.getState().set({ marginDoubt: { fdi: ctx.fdi, key, levels: r.levels, parts: r.parts, current: -1 } });
      })
      .catch(() => {
        // No colouring: the line is drawn plain.
      })
      .finally(() => {
        if (this.doubtKey === key) this.doubtKey = null;
      });
  }

  /** Fly the camera to the next (or previous) doubtful part of the margin, framed obliquely onto the cervical area. */
  nextDoubt(step = 1): void {
    const ctx = toothContext();
    const doubt = useToolStore.getState().marginDoubt;
    const frame = ctx?.tooth.frame;
    if (!ctx || !frame || !doubt || doubt.fdi !== ctx.fdi || !this.viewer) return;
    if (doubt.parts.length === 0) {
      useToolStore.getState().set({ message: { kind: 'info', text: 'No doubtful parts on this line.' } });
      return;
    }
    const n = doubt.parts.length;
    const current = doubt.current < 0 ? (step > 0 ? 0 : n - 1) : (doubt.current + step + n) % n;
    const part = doubt.parts[current]!;
    const o = frame.occlusal, origin = frame.origin;
    const out: V3 = [part.at[0] - origin[0]!, part.at[1] - origin[1]!, part.at[2] - origin[2]!];
    const along = out[0] * o[0]! + out[1] * o[1]! + out[2] * o[2]!;
    const flat: V3 = [out[0] - along * o[0]!, out[1] - along * o[1]!, out[2] - along * o[2]!];
    const len = Math.hypot(...flat) || 1;
    const toCamera: V3 = [flat[0] / len + 0.7 * o[0]!, flat[1] / len + 0.7 * o[1]!, flat[2] / len + 0.7 * o[2]!];
    this.viewer.focus(part.at, toCamera, 18);
    useToolStore.getState().set({
      marginDoubt: { ...doubt, current },
      message: { kind: 'info', text: `Doubtful part ${current + 1} of ${n}: a stronger edge lies ${Math.abs(part.offsetMm).toFixed(1)} mm ${part.offsetMm > 0 ? 'above' : 'below'} the line here.` },
    });
  }

  /** Move the whole margin `mm` along the tooth axis (+ toward the occlusal), back onto the scan. */
  async offset(mm: number): Promise<void> {
    const ctx = toothContext();
    const margin = ctx?.tooth.margin;
    const frame = ctx?.tooth.frame;
    if (!ctx || !margin || !frame || useToolStore.getState().busy) return;
    const along = { origin: [frame.origin[0]!, frame.origin[1]!, frame.origin[2]!] as V3, up: [frame.occlusal[0]!, frame.occlusal[1]!, frame.occlusal[2]!] as V3 };
    // Busy while it runs: a quick second key press waits for this one instead of starting from the same line.
    useToolStore.getState().set({ busy: mm > 0 ? 'Raising the line…' : 'Lowering the line…' });
    try {
      const [points, anchors] = await Promise.all([
        analysis.offsetPoints(ctx.jaw.sha256, fromMarginPoints(margin.points), along, mm),
        analysis.offsetPoints(ctx.jaw.sha256, fromMarginPoints(margin.anchors), along, mm),
      ]);
      useDesignStore.getState().dispatch({ type: 'setMargin', fdi: ctx.fdi, margin: { ...margin, points: toMarginPoints(points), anchors: toMarginPoints(anchors), source: 'manual' } });
    } catch (e) {
      useToolStore.getState().set({ message: { kind: 'error', text: `Could not move the margin: ${errorText(e)}` } });
    } finally {
      useToolStore.getState().set({ busy: null });
    }
  }

  /** Remove the margin point under the cursor and re-trace only between its neighbours (Delete or Backspace). */
  async deleteHovered(): Promise<boolean> {
    const ctx = toothContext();
    const margin = ctx?.tooth.margin;
    const i = this.hovered;
    if (!ctx || !margin || i < 0 || i >= margin.anchors.length) return false;
    if (margin.anchors.length <= 3) {
      useToolStore.getState().set({ message: { kind: 'warning', text: 'A margin needs at least 3 points.' } });
      return true;
    }
    const anchors = margin.anchors.map((a) => [...a.p] as V3);
    const n = anchors.length;
    const before = anchors[(i - 1 + n) % n]!, after = anchors[(i + 1) % n]!;
    this.hovered = -1;
    this.viewer?.overlays.remove('margin:hover');
    await this.commitLocal([before, after], before, after, anchors[i]!, anchors.filter((_, k) => k !== i), 'Point removed.');
    return true;
  }

  /**
   * Re-trace only the stretch between two neighbouring points, through `waypoints`, and keep the rest of the line
   * (specs/2026-10-27-margin-review-ux.md): `via` is a point of the old stretch.
   */
  private async commitLocal(waypoints: V3[], from: V3, to: V3, via: V3, anchors: V3[], done: string): Promise<boolean> {
    const ctx = toothContext();
    const margin = ctx?.tooth.margin;
    if (!ctx || !margin) return false;
    const tools = useToolStore.getState();
    tools.set({ busy: 'Re-tracing…', message: null });
    try {
      const packed = await analysis.traceOpen(ctx.jaw.sha256, waypoints, marginLineOf(ctx.fdi));
      const path = Array.from({ length: packed.length / 3 }, (_, k): V3 => [packed[k * 3]!, packed[k * 3 + 1]!, packed[k * 3 + 2]!]);
      const points = replaceArc(margin.points.map((m) => [...m.p] as V3), from, to, via, path);
      useDesignStore.getState().dispatch({
        type: 'setMargin',
        fdi: ctx.fdi,
        margin: { ...margin, anchors: anchors.map((p) => ({ p })), points: toMarginPoints(new Float32Array(points.flat())), source: 'manual' },
      });
      tools.set({ message: { kind: 'info', text: done } });
      return true;
    } catch (e) {
      if (!isStale(e)) tools.set({ message: { kind: 'error', text: `Could not re-trace the margin: ${errorText(e)}` } });
      return false;
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
    // Gum-line marks: the tooth's kept marks plus the stroke being painted.
    const marks = useToolStore.getState().scribbles;
    const brush = useToolStore.getState().scribbleBrush;
    for (const kind of ['tooth', 'gum'] as const) {
      const kept = ctx && marks?.fdi === ctx.fdi ? marks[kind] : [];
      const points = [...kept, ...(this.stroke && brush === kind ? this.stroke : [])];
      if (points.length) v.overlays.setMarkers(`margin:marks-${kind}`, points, { color: MARK_COLORS[kind], sizePx: 7 });
      else v.overlays.remove(`margin:marks-${kind}`);
    }
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

  /** The accepted margin's point under the cursor (within SNAP_PX), or −1. */
  private anchorAt(e: PointerEvent): number {
    const margin = toothContext()?.tooth.margin;
    const viewer = this.viewer;
    if (!margin || !viewer) return -1;
    return margin.anchors.findIndex((a) => {
      const s = viewer.project(a.p as V3);
      return s && Math.hypot(s.x - e.clientX, s.y - e.clientY) < SNAP_PX;
    });
  }

  /** Whether the cursor is on the accepted margin line (within ON_LINE_PX on screen), not on one of its points. */
  private onLine(e: PointerEvent): boolean {
    const margin = toothContext()?.tooth.margin;
    const viewer = this.viewer;
    if (!margin || !viewer || this.anchorAt(e) >= 0) return false;
    const screen = margin.points.map((m) => viewer.project(m.p as V3));
    for (let i = 0; i < screen.length; i++) {
      const a = screen[i], b = screen[(i + 1) % screen.length];
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((e.clientX - a.x) * dx + (e.clientY - a.y) * dy) / (dx * dx + dy * dy || 1)));
      if (Math.hypot(a.x + t * dx - e.clientX, a.y + t * dy - e.clientY) < ON_LINE_PX) return true;
    }
    return false;
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
    if (useToolStore.getState().scribbleBrush) {
      if (hit && hit.objectId === ctx.jaw.role) await this.addMarks([[hit.point.x, hit.point.y, hit.point.z]]);
      return;
    }
    const tools = useToolStore.getState();
    const anchors = tools.marginAnchors;
    if (anchors.length >= 3 && this.nearFirstAnchor(e)) {
      await this.close();
      return;
    }
    if (!hit || hit.objectId !== ctx.jaw.role) return;
    // A click on the accepted line adds a point there (the line does not change); elsewhere it starts a new loop.
    if (anchors.length === 0 && ctx.tooth.margin && this.onLine(e)) {
      const margin = ctx.tooth.margin;
      const p: V3 = [hit.point.x, hit.point.y, hit.point.z];
      const next = insertAnchor({ anchors: margin.anchors.map((a) => [...a.p] as V3), points: margin.points.map((m) => [...m.p] as V3) }, p);
      useDesignStore.getState().dispatch({ type: 'setMargin', fdi: ctx.fdi, margin: { ...margin, anchors: next.map((q) => ({ p: q })), source: 'manual' } });
      tools.set({ message: { kind: 'info', text: 'Point added: drag it to move the line there.' } });
      return;
    }
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
    if (ctx && hit && hit.objectId === ctx.jaw.role) this.requestSection([hit.point.x, hit.point.y, hit.point.z]);
    if (ctx && useToolStore.getState().sectionRedraw?.first) {
      const path = hit && hit.objectId === ctx.jaw.role && this.tree ? pathFromTree(this.tree.pred, nearestCorner(ctx.jaw.geometry, hit.faceIndex, hit.point)) : null;
      this.redraw(path ? pathPositions(ctx.jaw.geometry, path) : null);
      return;
    }
    // On an accepted line: highlight the point under the cursor (Delete removes it).
    if (ctx && anchors.length === 0 && ctx.tooth.margin && !useToolStore.getState().sectionRedraw) {
      const i = this.anchorAt(e);
      if (i !== this.hovered) {
        this.hovered = i;
        if (i >= 0) this.viewer?.overlays.setMarkers('margin:hover', [ctx.tooth.margin.anchors[i]!.p], { color: '#ffffff', outline: MARGIN_COLOR, sizePx: 15 });
        else this.viewer?.overlays.remove('margin:hover');
      }
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
    // Painting marks: the drag is a brush stroke.
    if (useToolStore.getState().scribbleBrush) {
      this.stroke = [];
      return true;
    }
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
    if (this.stroke && ctx && hit && hit.objectId === ctx.jaw.role) {
      const p: V3 = [hit.point.x, hit.point.y, hit.point.z];
      const last = this.stroke.at(-1);
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]) > 0.15) {
        this.stroke.push(p);
        this.redraw();
      }
      return;
    }
    if (!this.drag || !ctx || !hit || hit.objectId !== ctx.jaw.role) return;
    this.drag.anchors[this.drag.index] = [hit.point.x, hit.point.y, hit.point.z];
    this.redraw();
  }

  /** Keep a brush stroke's marks (with the tooth's earlier ones) and find the gum line again. */
  private async addMarks(points: V3[]): Promise<void> {
    const ctx = toothContext();
    const brush = useToolStore.getState().scribbleBrush;
    if (!ctx || !brush || points.length === 0) return;
    const known = useToolStore.getState().scribbles;
    const marks = known && known.fdi === ctx.fdi ? known : { fdi: ctx.fdi, tooth: [], gum: [] };
    useToolStore.getState().set({ scribbles: { ...marks, [brush]: [...marks[brush], ...points] } });
    this.redraw();
    await this.solveWithMarks();
  }

  /** A dragged point re-traces only between its two neighbours; the rest of the line stays as it is. */
  private async dragEnd(): Promise<void> {
    if (this.stroke) {
      const stroke = this.stroke;
      this.stroke = null;
      await this.addMarks(stroke);
      return;
    }
    const drag = this.drag;
    const margin = toothContext()?.tooth.margin;
    if (!drag || !margin) return;
    const n = drag.anchors.length;
    const before = drag.anchors[(drag.index - 1 + n) % n]!, after = drag.anchors[(drag.index + 1) % n]!;
    const old = [...margin.anchors[drag.index]!.p] as V3;
    const moved = drag.anchors[drag.index]!;
    // A press without a move changes nothing.
    if (Math.hypot(moved[0] - old[0], moved[1] - old[1], moved[2] - old[2]) > 0.02) {
      await this.commitLocal([before, moved, after], before, after, old, drag.anchors, 'Point moved.');
    }
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
      // The anchors where the trace took them: snapped onto the ridge, so the points sit on the line.
      const snapped = trace.anchorPoints;
      const at = (p: V3, i: number): V3 => (snapped && snapped.length === anchors.length * 3 ? [snapped[i * 3]!, snapped[i * 3 + 1]!, snapped[i * 3 + 2]!] : p);
      useDesignStore.getState().dispatch({
        type: 'setMargin',
        fdi: ctx.fdi,
        margin: {
          anchors: anchors.map((p, i) => ({ p: at(p, i) })),
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

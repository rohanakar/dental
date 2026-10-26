import { bridgeOf, type DesignDocument, MAX_UNSUPPORTED_VENEER_MM, type StepId, VENEER_TOLERANCE_MM } from '@dcad/shared';
import { BufferAttribute, BufferGeometry } from 'three';
import { create } from 'zustand';
import { useDesignStore } from '../design/store';
import { COLOR_MAPS, thresholdStops } from '../engine/colormap';
import type { Viewer } from '../engine/Viewer';
import { downloadBytes } from '../io/exportCrown';
import { frameworkSidecar, frameworkStl, overpressStl } from '../io/exportFramework';
import { useSessionStore } from '../state/session';
import type { CrownResult } from '../workers/analysisTypes';
import type { FrameworkView, OverpressView } from '../workers/frameworkTypes';
import { bridgeTool, bridgeUnitObjectId, useBridgeStore } from './bridgeTool';
import { errorText } from './context';
import { WARNING_COLOR } from './crownLegend';
import { CROWN_OBJECT_ID, crownTool } from './crownTool';
import { type LegendSpec, useToolStore } from './toolStore';

/**
 * Framework (reduced) units in the editor (specs/2026-10-25-framework-bridges.md). The worker cuts each reduced unit
 * back on top of its anatomy (crownTool / bridgeTool requests carry the cutback); this tool shows the result:
 * - the view: the anatomy, the framework, or both with the anatomy as a ghost over the framework;
 * - the veneer-space colour map on the framework;
 * - the framework and overpress exports.
 * Called from crownTool.sync (after the anatomy is shown) and on each new crown or bridge result.
 */

export type FrameworkViewMode = 'anatomy' | 'framework' | 'both';

/** Steps in which the restorations are shown (as crownTool and bridgeTool do). */
const SHOW: readonly StepId[] = ['params', 'proposal', 'adapt', 'finalize'];
/** Opacity of the anatomy over the framework in the "both" view. */
const GHOST_OPACITY = 0.28;
const PREFIX = 'framework:';
const objectId = (fdi: number) => `${PREFIX}${fdi}`;

export interface FrameworkState {
  view: FrameworkViewMode;
  /** The veneer-space colour map on the framework. */
  veneerMap: boolean;
  /** Frameworks of the displayed units (the active tooth, or its bridge), by tooth. */
  units: Record<number, FrameworkView>;
  /** An export in progress (a single crown's overpress part is made on export). */
  busy: string | null;
  error: string | null;
}

export const useFrameworkStore = create<FrameworkState>()(() => ({ view: 'framework', veneerMap: false, units: {}, busy: null, error: null }));

/** The veneer-space legend for a cutback: anything thinner than requested in the warning colour. */
export function veneerLegend(thicknessMm: number): LegendSpec {
  const range: [number, number] = [0, Math.max(MAX_UNSUPPORTED_VENEER_MM, 2 * thicknessMm)];
  return {
    title: 'Veneer space',
    map: 'sequential',
    range,
    unit: 'mm',
    lowLabel: 'thin',
    highLabel: 'thick',
    stops: thresholdStops(COLOR_MAPS.sequential, range, thicknessMm - VENEER_TOLERANCE_MM, WARNING_COLOR),
    ticks: [
      { value: thicknessMm, label: `${thicknessMm} mm requested` },
      { value: MAX_UNSUPPORTED_VENEER_MM, label: `${MAX_UNSUPPORTED_VENEER_MM} mm unsupported porcelain`, dashed: true },
    ],
  };
}

const caseRef = (doc: DesignDocument) => (doc.setup.patientRef || useSessionStore.getState().currentCase?.patientRef || 'case').replace(/[^\w.-]+/g, '_');

class FrameworkTool {
  private viewer: Viewer | null = null;
  private readonly geometries = new Map<number, BufferGeometry>();
  /** The result the framework meshes were built from (a crown result, or the bridge result). */
  private source: unknown = null;
  /** Anatomy objects whose opacity this tool changed (restored when leaving the "both" view). */
  private ghosted = new Set<string>();
  private unsubscribe: (() => void) | null = null;

  attach(viewer: Viewer | null): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const fdi of [...this.geometries.keys()]) this.remove(fdi);
    this.source = null;
    this.ghosted.clear();
    this.viewer = viewer;
    if (!viewer) return;
    this.unsubscribe = crownTool.onResult(() => this.sync(useDesignStore.getState().activeStep));
    this.sync(useDesignStore.getState().activeStep);
  }

  setView(view: FrameworkViewMode): void {
    useFrameworkStore.setState({ view });
    // The anatomy's own display first (a view that hid it shows it again), then this tool's (crownTool.sync calls sync).
    crownTool.sync(useDesignStore.getState().activeStep);
  }

  setVeneerMap(on: boolean): void {
    // One colour map at a time: the crown maps are drawn on the anatomy.
    if (on && useToolStore.getState().crownMap !== 'none') useToolStore.getState().set({ crownMap: 'none' });
    useFrameworkStore.setState({ veneerMap: on });
    crownTool.sync(useDesignStore.getState().activeStep);
  }

  /** Called after crownTool / bridgeTool have shown the anatomy (crownTool.sync), and on each new result. */
  sync(step: StepId): void {
    // One colour map at a time: a crown map chosen since switches the veneer map off.
    if (useFrameworkStore.getState().veneerMap && useToolStore.getState().crownMap !== 'none') useFrameworkStore.setState({ veneerMap: false });
    const units = this.currentUnits();
    this.rebuild(units);
    this.applyDisplay(step, units);
  }

  /**
   * Download the framework STL of a single reduced crown. (A bridge exports its framework as the merged bridge.)
   * Returns the file name, or null.
   */
  exportFramework(): string | null {
    const result = crownTool.current();
    const { doc, activeFdi } = useDesignStore.getState();
    if (bridgeOf(doc, activeFdi) || !result?.framework) return null;
    const file = `${caseRef(doc)}-${activeFdi}-framework.stl`;
    downloadBytes(frameworkStl({ positions: result.framework.positions, indices: result.indices }), file, 'model/stl');
    return file;
  }

  /**
   * Download the overpress part of a reduced unit: in a bridge from the current check (made with the union), for a
   * single crown designed now in the worker. Returns the file name, or null.
   */
  async exportOverpress(fdi: number): Promise<string | null> {
    const { doc } = useDesignStore.getState();
    const bridge = bridgeOf(doc, fdi);
    let part: OverpressView | undefined;
    if (bridge) {
      const { check } = useBridgeStore.getState();
      part = check.current ? check.result?.overpress?.find((o) => o.fdi === fdi) : undefined;
    } else {
      part = (await this.singleWithOverpress())?.framework?.overpress;
    }
    if (!part) return null;
    const file = `${caseRef(doc)}-${fdi}-overpress.stl`;
    downloadBytes(overpressStl(part), file, 'model/stl');
    return file;
  }

  /** The framework section of the construction sidecar (crownTool and bridgeTool add it to theirs). */
  sidecar(units: ReadonlyArray<{ fdi: number; framework?: FrameworkView }>, overpress?: readonly OverpressView[]): ReturnType<typeof frameworkSidecar> | null {
    return units.some((u) => u.framework) ? frameworkSidecar(units, overpress) : null;
  }

  // ---- internals ----------------------------------------------------------------------------

  private async singleWithOverpress(): Promise<CrownResult | null> {
    useFrameworkStore.setState({ busy: 'Making the overpress part…', error: null });
    try {
      return await crownTool.evaluate([], { overpress: true });
    } catch (e) {
      useFrameworkStore.setState({ error: errorText(e) });
      return null;
    } finally {
      useFrameworkStore.setState({ busy: null });
    }
  }

  /** The displayed reduced units: the active crown, or every unit of the active bridge. */
  private currentUnits(): { source: unknown; units: Array<{ fdi: number; framework: FrameworkView; indices: Uint32Array; anatomyId: string }> } {
    const bridge = bridgeTool.current();
    if (bridgeTool.handles()) {
      const units = (bridge?.units ?? []).flatMap((u) => (u.framework ? [{ fdi: u.fdi, framework: u.framework, indices: u.indices, anatomyId: bridgeUnitObjectId(u.fdi) }] : []));
      return { source: bridge, units };
    }
    const crown = crownTool.current();
    const fdi = useDesignStore.getState().activeFdi;
    return { source: crown, units: crown?.framework ? [{ fdi, framework: crown.framework, indices: crown.indices, anatomyId: CROWN_OBJECT_ID }] : [] };
  }

  private rebuild({ source, units }: ReturnType<FrameworkTool['currentUnits']>): void {
    if (source === this.source) return;
    this.source = source;
    const keep = new Set(units.map((u) => u.fdi));
    for (const fdi of [...this.geometries.keys()]) if (!keep.has(fdi)) this.remove(fdi);
    for (const u of units) {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(u.framework.positions, 3));
      g.setIndex(new BufferAttribute(u.indices, 1));
      g.computeVertexNormals();
      g.computeBoundingBox();
      g.computeBoundingSphere();
      this.geometries.get(u.fdi)?.dispose();
      this.geometries.set(u.fdi, g);
      this.viewer?.addObject(objectId(u.fdi), g, { kind: 'restoration' });
    }
    useFrameworkStore.setState({ units: Object.fromEntries(units.map((u) => [u.fdi, u.framework])) });
  }

  private applyDisplay(step: StepId, { units }: ReturnType<FrameworkTool['currentUnits']>): void {
    const v = this.viewer;
    if (!v) return;
    const { view, veneerMap } = useFrameworkStore.getState();
    const { crownVisible, crownOpacity } = useToolStore.getState();
    const shown = SHOW.includes(step) && crownVisible;
    const ghosted = new Set<string>();
    for (const u of units) {
      const id = objectId(u.fdi);
      v.setObjectVisible(id, shown && view !== 'anatomy');
      v.setObjectScalars(id, veneerMap ? u.framework.veneer : null, veneerMap ? this.mapOptions(u.framework.cutback.thicknessMm) : undefined);
      if (!shown) continue;
      if (view === 'framework') v.setObjectVisible(u.anatomyId, false);
      if (view === 'both') {
        v.setObjectOpacity(u.anatomyId, Math.min(crownOpacity, GHOST_OPACITY));
        ghosted.add(u.anatomyId);
      }
    }
    for (const id of this.ghosted) if (!ghosted.has(id)) v.setObjectOpacity(id, crownOpacity);
    this.ghosted = ghosted;
    // The veneer legend while the map is on screen (the crown maps keep theirs otherwise).
    const active = useFrameworkStore.getState().units[useDesignStore.getState().activeFdi] ?? units[0]?.framework;
    const showMap = shown && veneerMap && view !== 'anatomy' && Boolean(active);
    const legend = useToolStore.getState().legend;
    if (showMap && active && legend?.title !== 'Veneer space') useToolStore.getState().set({ legend: veneerLegend(active.cutback.thicknessMm) });
    if (!showMap && legend?.title === 'Veneer space') useToolStore.getState().set({ legend: null });
  }

  private mapOptions(thicknessMm: number) {
    const spec = veneerLegend(thicknessMm);
    return { map: spec.map, range: spec.range, stops: spec.stops };
  }

  private remove(fdi: number): void {
    this.viewer?.removeObject(objectId(fdi));
    this.geometries.get(fdi)?.dispose();
    this.geometries.delete(fdi);
  }
}

export const frameworkTool = new FrameworkTool();

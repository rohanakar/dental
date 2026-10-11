import type { StepId } from '@dcad/shared';
import { BufferAttribute, BufferGeometry } from 'three';
import { useDesignStore } from '../design/store';
import type { Viewer } from '../engine/Viewer';
import { constructionInfo, crownStl, downloadBytes } from '../io/exportCrown';
import { useSessionStore } from '../state/session';
import type { CrownMapName, CrownRequest, CrownResult } from '../workers/analysisTypes';
import { analysis } from '../workers/geometryClient';
import { isStale } from '../workers/latestWins';
import { errorText, fromMarginPoints, toothContext, type ToothContext } from './context';
import { useToolStore, type LegendSpec } from './toolStore';

export const CROWN_OBJECT_ID = 'crown';
/** Steps in which the crown is shown. */
const SHOW_CROWN: readonly StepId[] = ['params', 'proposal', 'adapt', 'finalize'];
const APP_VERSION = '0.3.0';

const v3 = (p: readonly number[]): [number, number, number] => [p[0]!, p[1]!, p[2]!];

/** How each crown map is shown (range and legend). */
export const CROWN_MAPS: Record<CrownMapName, LegendSpec> = {
  thickness: { title: 'Material thickness', map: 'sequential', range: [0, 2], unit: 'mm', lowLabel: 'thin', highLabel: 'thick' },
  occlusion: { title: 'Occlusal clearance', map: 'diverging', range: [-0.2, 0.5], unit: 'mm', lowLabel: 'penetration', highLabel: 'gap' },
  proximal: { title: 'Proximal clearance', map: 'diverging', range: [-0.2, 0.5], unit: 'mm', lowLabel: 'penetration', highLabel: 'gap' },
  unmillable: { title: 'Unmillable (tool radius)', map: 'undercut', range: [0, 0.2], unit: 'mm', lowLabel: 'millable', highLabel: 'unreachable' },
};

function request(ctx: ToothContext, withPose: boolean, map: CrownMapName | 'none'): CrownRequest | null {
  const { frame, margin, axis, params, crown } = ctx.tooth;
  if (!frame || !margin || !axis) return null;
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
    margin: fromMarginPoints(margin.points),
    axis: v3(axis.direction),
    params,
    pose: withPose && crown?.kind === 'template' ? crown.pose : undefined,
    maps: map === 'none' ? undefined : [map],
    adapt: withPose && crown?.kind === 'template' ? crown.adapt : undefined,
  };
}

/**
 * The crown mesh is derived data: recomputed in the worker from (scans,
 * frame, margin, axis, params, crown pose) whenever any of them changes, so
 * undo/redo and parameter edits always show the matching crown.
 */
class CrownTool {
  private viewer: Viewer | null = null;
  private inputs: unknown[] = [];
  private geometry: BufferGeometry | null = null;
  private last: CrownResult | null = null;

  attach(viewer: Viewer | null): void {
    this.viewer = viewer;
    this.inputs = [];
    if (viewer && this.geometry) this.show();
  }

  /** Called on every store change. */
  sync(step: StepId): void {
    const ctx = toothContext();
    const crown = ctx?.tooth.crown;
    const inputs = [ctx?.jaw.sha256, ctx?.antagonist?.sha256, ctx?.tooth.frame, ctx?.tooth.margin, ctx?.tooth.axis, ctx?.tooth.params, crown, useToolStore.getState().crownMap];
    if (!ctx || !crown) {
      this.clear();
    } else if (inputs.some((x, i) => x !== this.inputs[i])) {
      this.inputs = inputs;
      void this.compute(ctx, true);
    }
    this.applyVisibility(step);
  }

  /** Propose a new template pose from the frame, contacts and antagonist (setCrown). */
  async propose(): Promise<void> {
    const ctx = toothContext();
    if (!ctx) return;
    const result = await this.compute(ctx, false);
    if (!result) return;
    useDesignStore.getState().dispatch({
      type: 'setCrown',
      fdi: ctx.fdi,
      crown: { kind: 'template', templateId: result.templateId, pose: result.pose },
    });
    // The mesh on screen already matches the new document state.
    const after = toothContext();
    this.inputs = [after?.jaw.sha256, after?.antagonist?.sha256, after?.tooth.frame, after?.tooth.margin, after?.tooth.axis, after?.tooth.params, after?.tooth.crown, useToolStore.getState().crownMap];
  }

  /** Choose the colour map on the crown (recomputes with the map). */
  setMap(map: CrownMapName | 'none'): void {
    useToolStore.getState().set({ crownMap: map });
    this.sync(useDesignStore.getState().activeStep);
  }

  setVisible(visible: boolean): void {
    useToolStore.getState().set({ crownVisible: visible });
    this.applyVisibility(useDesignStore.getState().activeStep);
  }

  setOpacity(opacity: number): void {
    useToolStore.getState().set({ crownOpacity: opacity });
    this.viewer?.setObjectOpacity(CROWN_OBJECT_ID, opacity);
  }

  /**
   * Download the crown as binary STL, or the construction-info sidecar.
   * Separate actions: browsers block a second download started by one click.
   */
  export(kind: 'stl' | 'info'): void {
    const ctx = toothContext();
    const last = this.last;
    if (!ctx || !last) return;
    const { doc } = useDesignStore.getState();
    const caseRef = (doc.setup.patientRef || useSessionStore.getState().currentCase?.patientRef || 'case').replace(/[^\w.-]+/g, '_');
    const base = `${caseRef}-${ctx.fdi}`;
    if (kind === 'stl') {
      downloadBytes(crownStl({ positions: last.positions, indices: last.indices }), `${base}.stl`, 'model/stl');
    } else {
      const info = constructionInfo({ doc, tooth: ctx.tooth, appVersion: APP_VERSION, result: last });
      downloadBytes(JSON.stringify(info, null, 2), `${base}.construction.json`, 'application/json');
    }
  }

  /** Current crown mesh (for tests and export). */
  current(): CrownResult | null {
    return this.last;
  }

  private async compute(ctx: ToothContext, withPose: boolean): Promise<CrownResult | null> {
    const map = useToolStore.getState().crownMap;
    const req = request(ctx, withPose, map);
    if (!req) return null;
    const tools = useToolStore.getState();
    tools.set({ crown: { ...(tools.crown ?? { warnings: [] }), computing: true, error: undefined } });
    try {
      const result = await analysis.designCrown(req);
      this.last = result;
      this.setMesh(result);
      this.applyMap(map, result);
      useToolStore.getState().set({
        crown: {
          computing: false,
          templateId: result.templateId,
          triangles: result.indices.length / 3,
          validation: result.validation,
          minAxialThicknessMm: result.minAxialThicknessMm,
          gapCheck: result.gapCheck,
          thickness: result.thickness,
          adapt: result.adapt,
          warnings: result.warnings,
          ms: result.ms,
        },
      });
      return result;
    } catch (e) {
      if (isStale(e)) return null;
      useToolStore.getState().set({ crown: { computing: false, error: errorText(e), warnings: [] } });
      return null;
    }
  }

  private applyMap(map: CrownMapName | 'none', result: CrownResult): void {
    const values = map === 'none' ? undefined : result.maps?.[map];
    const spec = map === 'none' ? null : CROWN_MAPS[map];
    this.viewer?.setObjectScalars(CROWN_OBJECT_ID, values && spec ? values : null, spec ? { map: spec.map, range: spec.range } : undefined);
    // Conflict markers (insufficient reduction / contact too tight) at the conflict centroids.
    const conflicts = Object.values(result.adapt ?? {}).flatMap((r) => (r?.conflict ? [r.conflict.at] : []));
    if (conflicts.length > 0) this.viewer?.overlays.setMarkers('crown:conflicts', conflicts, { color: '#d64545', outline: '#ffffff', sizePx: 16 });
    else this.viewer?.overlays.remove('crown:conflicts');
    if (useDesignStore.getState().activeStep !== 'axis') useToolStore.getState().set({ legend: values && spec ? spec : null });
  }

  private setMesh(result: CrownResult): void {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(result.positions.slice(), 3));
    g.setIndex(new BufferAttribute(result.indices.slice(), 1));
    g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    this.geometry?.dispose();
    this.geometry = g;
    this.show();
  }

  private show(): void {
    if (!this.viewer || !this.geometry) return;
    this.viewer.addObject(CROWN_OBJECT_ID, this.geometry, { kind: 'restoration' });
    this.viewer.setObjectOpacity(CROWN_OBJECT_ID, useToolStore.getState().crownOpacity);
    this.applyVisibility(useDesignStore.getState().activeStep);
  }

  private applyVisibility(step: StepId): void {
    const visible = SHOW_CROWN.includes(step) && useToolStore.getState().crownVisible;
    this.viewer?.setObjectVisible(CROWN_OBJECT_ID, visible);
    if (!visible) this.viewer?.overlays.remove('crown:conflicts');
    // The legend belongs to the crown map only while the crown is on screen (the axis step has its own).
    const { legend, crownMap } = useToolStore.getState();
    if (!visible && legend && crownMap !== 'none' && legend === CROWN_MAPS[crownMap]) useToolStore.getState().set({ legend: null });
    if (visible && crownMap !== 'none' && this.last?.maps?.[crownMap] && legend !== CROWN_MAPS[crownMap]) {
      useToolStore.getState().set({ legend: CROWN_MAPS[crownMap] });
    }
  }

  private clear(): void {
    if (!this.geometry && !this.last) return;
    this.viewer?.removeObject(CROWN_OBJECT_ID);
    this.viewer?.overlays.remove('crown:conflicts');
    this.geometry?.dispose();
    this.geometry = null;
    this.last = null;
    this.inputs = [];
    useToolStore.getState().set({ crown: null });
  }
}

export const crownTool = new CrownTool();

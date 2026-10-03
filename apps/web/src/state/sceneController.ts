import type { ScanRole } from '@dcad/shared';
import type { BufferGeometry } from 'three';
import type { StandardView } from '../engine/viewFrame';
import { estimateViewFrame } from '../engine/viewFrame';
import type { Projection, Viewer } from '../engine/Viewer';
import { cancelImport, importDemoScan, importScanFile, type LoadedScan } from '../workers/geometryClient';
import { isStale } from '../workers/latestWins';
import { useSceneStore, type SceneObjectState } from './sceneStore';

/**
 * Glue between the zustand store (UI state) and the imperative Viewer.
 * Geometry lives here, not in the store: it is large and non-serializable.
 */
class SceneController {
  private viewer: Viewer | null = null;
  private readonly geometries = new Map<string, BufferGeometry>();

  attachViewer(viewer: Viewer): void {
    this.viewer = viewer;
    // Re-add anything loaded before the viewer mounted (e.g. after HMR).
    for (const obj of useSceneStore.getState().objects) {
      const g = this.geometries.get(obj.id);
      if (g && obj.phase === 'ready') this.addToViewer(obj, g);
    }
    viewer.setProjection(useSceneStore.getState().projection);
  }

  detachViewer(viewer: Viewer): void {
    if (this.viewer === viewer) this.viewer = null;
  }

  async importFile(file: File, role: ScanRole): Promise<void> {
    await this.load(role, file.name, () => importScanFile(file, role));
  }

  async loadDemo(): Promise<void> {
    await Promise.all([
      this.load('lower', 'Demo lower arch (synthetic)', () => importDemoScan('lower', 'lower')),
      this.load('upper', 'Demo upper arch (synthetic)', () => importDemoScan('upper', 'upper')),
    ]);
  }

  remove(id: string): void {
    cancelImport(id);
    this.viewer?.removeObject(id);
    this.geometries.get(id)?.dispose();
    this.geometries.delete(id);
    useSceneStore.getState().removeObject(id);
    this.updateViewFrame();
  }

  setVisible(id: string, visible: boolean): void {
    useSceneStore.getState().patchObject(id, { visible });
    this.viewer?.setObjectVisible(id, visible);
  }

  setOpacity(id: string, opacity: number): void {
    useSceneStore.getState().patchObject(id, { opacity });
    this.viewer?.setObjectOpacity(id, opacity);
  }

  setVertexColors(id: string, useVertexColors: boolean): void {
    useSceneStore.getState().patchObject(id, { useVertexColors });
    this.viewer?.setObjectVertexColors(id, useVertexColors);
  }

  setView(view: StandardView): void {
    this.viewer?.setView(view);
  }

  fit(): void {
    this.viewer?.fit();
  }

  setProjection(projection: Projection): void {
    useSceneStore.getState().setProjection(projection);
    this.viewer?.setProjection(projection);
  }

  async screenshot(): Promise<void> {
    if (!this.viewer) return;
    const blob = await this.viewer.screenshot();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dcad-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private async load(role: ScanRole, name: string, run: () => Promise<LoadedScan>): Promise<void> {
    const store = useSceneStore.getState();
    const id = role;
    const isFirst = this.geometries.size === 0;
    store.upsertObject({ id, name, role });
    store.patchObject(id, { phase: 'processing' });
    try {
      const loaded = await run();
      this.viewer?.removeObject(id);
      this.geometries.get(id)?.dispose();
      this.geometries.set(id, loaded.geometry);
      const { stats, warnings, sha256, bvhMs } = loaded.payload;
      store.patchObject(id, {
        phase: 'ready',
        stats,
        warnings,
        sha256,
        bvhMs,
        hasColors: stats.hasColors,
      });
      const obj = useSceneStore.getState().objects.find((o) => o.id === id);
      if (obj) this.addToViewer(obj, loaded.geometry);
      this.updateViewFrame();
      if (isFirst) this.viewer?.setView('buccal', false);
    } catch (e) {
      if (isStale(e)) return; // superseded by a newer import for this role
      store.patchObject(id, { phase: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }

  private addToViewer(obj: SceneObjectState, geometry: BufferGeometry): void {
    const v = this.viewer;
    if (!v) return;
    v.addObject(obj.id, geometry, { kind: 'jaw', vertexColors: obj.useVertexColors });
    v.setObjectVisible(obj.id, obj.visible);
    v.setObjectOpacity(obj.id, obj.opacity);
  }

  /** Re-estimate the whole-arch view frame from the loaded jaws. */
  private updateViewFrame(): void {
    const objects = useSceneStore.getState().objects.filter((o) => o.phase === 'ready');
    const jaws = objects.flatMap((o) => {
      const g = this.geometries.get(o.id);
      const positions = g?.getAttribute('position')?.array;
      const normals = g?.getAttribute('normal')?.array;
      if (!(positions instanceof Float32Array) || !(normals instanceof Float32Array)) return [];
      return [{ role: o.role, positions, normals }];
    });
    const frame = estimateViewFrame(jaws);
    if (frame) this.viewer?.setViewFrame(frame);
  }
}

export const sceneController = new SceneController();

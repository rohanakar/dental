import { jawOf, type ScanRef, type ScanRole } from '@dcad/shared';
import type { BufferGeometry } from 'three';
import { useDesignStore } from '../design/store';
import type { StandardView } from '../engine/viewFrame';
import { estimateViewFrame } from '../engine/viewFrame';
import type { Projection, Viewer } from '../engine/Viewer';
import {
  analysis,
  cancelImport,
  importDemoScan,
  importScanBytes,
  importScanFile,
  type LoadedScan,
} from '../workers/geometryClient';
import { isStale } from '../workers/latestWins';
import { useSceneStore, type SceneObjectState } from './sceneStore';

/**
 * Where imported scans are persisted. Set while a backend case is open;
 * null in offline mode (scans then live only in this browser tab).
 */
export interface ScanPersistence {
  /** Upload the scan's original file bytes; resolves to the backend file id. */
  upload(input: { role: ScanRole; name: string; sha256: string; blob: Blob }): Promise<string>;
}

interface CachedScan {
  geometry: BufferGeometry;
  payload: LoadedScan['payload'];
}

const ROLES: readonly ScanRole[] = ['lower', 'upper', 'preop'];

/**
 * Glue between the stores (UI + document state) and the imperative Viewer.
 * The design document is the source of truth for which scans are in the
 * case: the viewer shows `doc.scans`, so undo/redo of scan changes works.
 * Geometry lives here, not in a store: it is large and non-serializable, and
 * cached by content hash.
 */
class SceneController {
  private viewer: Viewer | null = null;
  private readonly cache = new Map<string, CachedScan>();
  /** sha256 currently shown in the viewer, per role. */
  private readonly shown = new Map<ScanRole, string>();
  private persistence: ScanPersistence | null = null;
  /** Per-role import generation, so a superseded import never dispatches. */
  private readonly generation = new Map<ScanRole, number>();
  /** Original file bytes per sha256 (for upload and the local project zip). */
  private readonly sources = new Map<string, Blob>();

  constructor() {
    useDesignStore.subscribe((s, prev) => {
      if (s.doc.scans !== prev.doc.scans) this.reconcile();
    });
  }

  attachViewer(viewer: Viewer): void {
    this.viewer = viewer;
    this.shown.clear();
    viewer.setProjection(useSceneStore.getState().projection);
    this.reconcile();
  }

  detachViewer(viewer: Viewer): void {
    if (this.viewer === viewer) this.viewer = null;
  }

  setPersistence(persistence: ScanPersistence | null): void {
    this.persistence = persistence;
  }

  /** The scan's original file bytes, if this tab imported or downloaded it. */
  sourceFor(sha256: string): Blob | null {
    return this.sources.get(sha256) ?? null;
  }

  /** Geometry (with BVH) of the scan currently in the document for a role. */
  geometryFor(role: ScanRole): { geometry: BufferGeometry; sha256: string } | null {
    const sha256 = this.shown.get(role);
    const cached = sha256 ? this.cache.get(sha256) : undefined;
    return cached && sha256 ? { geometry: cached.geometry, sha256 } : null;
  }

  async importFile(file: File, role: ScanRole): Promise<void> {
    await this.importScan(role, file.name, () => importScanFile(file, role), async () => file);
  }

  async loadDemo(): Promise<void> {
    const demo = (jaw: 'lower' | 'upper', name: string) => {
      let source: Uint8Array | null = null;
      return this.importScan(
        jaw,
        name,
        async () => {
          const loaded = await importDemoScan(jaw, jaw);
          source = loaded.source;
          return loaded;
        },
        async () => new Blob([source as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }),
      );
    };
    await Promise.all([demo('lower', 'demo-lower.ply'), demo('upper', 'demo-upper.ply')]);
  }

  /**
   * Load scans that are already in the document (opening a saved case).
   * Nothing is dispatched; the worker re-verifies each file's sha256.
   */
  async loadScans(scans: readonly ScanRef[], fetchBytes: (scan: ScanRef) => Promise<ArrayBuffer>): Promise<void> {
    await Promise.all(
      scans.map(async (scan) => {
        if (this.cache.has(scan.mesh.sha256)) return this.reconcile();
        const store = useSceneStore.getState();
        store.upsertObject({ id: scan.role, name: scan.name, role: scan.role });
        store.patchObject(scan.role, { phase: 'reading' });
        try {
          const bytes = await fetchBytes(scan);
          // Keep a copy of the original bytes: the ArrayBuffer is transferred to the worker next.
          const source = new Blob([bytes], { type: 'application/octet-stream' });
          store.patchObject(scan.role, { phase: 'processing' });
          const loaded = await importScanBytes(bytes, scan.name, scan.role);
          if (loaded.payload.sha256 !== scan.mesh.sha256) {
            throw new Error('Downloaded scan does not match its recorded checksum');
          }
          this.cache.set(scan.mesh.sha256, { geometry: loaded.geometry, payload: loaded.payload });
          this.sources.set(scan.mesh.sha256, source);
          this.reconcile();
        } catch (e) {
          if (isStale(e)) return;
          store.patchObject(scan.role, { phase: 'error', error: e instanceof Error ? e.message : String(e) });
        }
      }),
    );
  }

  /** Load scans whose bytes are already in memory (opening a local project file). */
  async loadLocalScans(scans: ReadonlyArray<{ ref: ScanRef; bytes: Uint8Array }>): Promise<void> {
    const bySha = new Map(scans.map((s) => [s.ref.mesh.sha256, s.bytes]));
    await this.loadScans(
      scans.map((s) => s.ref),
      // Copy into an exact-size buffer: unzipped entries may be views into a larger one.
      async (ref) => bySha.get(ref.mesh.sha256)!.slice().buffer as ArrayBuffer,
    );
  }

  /** Remove a scan from the case (undoable). */
  remove(role: ScanRole): void {
    cancelImport(role);
    this.generation.set(role, (this.generation.get(role) ?? 0) + 1);
    const inDoc = useDesignStore.getState().doc.scans.some((s) => s.role === role);
    if (inDoc) useDesignStore.getState().dispatch({ type: 'removeScan', role });
    else this.dropObject(role);
  }

  /** Forget every scan and its geometry (switching cases). */
  clear(): void {
    for (const role of ROLES) {
      cancelImport(role);
      this.generation.set(role, (this.generation.get(role) ?? 0) + 1);
      this.dropObject(role);
    }
    for (const [sha, c] of this.cache) {
      c.geometry.dispose();
      void analysis.releaseScan(sha);
    }
    this.cache.clear();
    this.sources.clear();
  }

  setVisible(id: ScanRole, visible: boolean): void {
    useSceneStore.getState().patchObject(id, { visible });
    this.viewer?.setObjectVisible(id, visible);
  }

  setOpacity(id: ScanRole, opacity: number): void {
    useSceneStore.getState().patchObject(id, { opacity });
    this.viewer?.setObjectOpacity(id, opacity);
  }

  setVertexColors(id: ScanRole, useVertexColors: boolean): void {
    useSceneStore.getState().patchObject(id, { useVertexColors });
    this.viewer?.setObjectVertexColors(id, useVertexColors);
  }

  /** A standard view; the occlusal one looks onto the active tooth's jaw (from below an upper tooth). */
  setView(view: StandardView): void {
    const fdi = useDesignStore.getState().activeFdi;
    this.viewer?.setView(view, true, fdi ? jawOf(fdi) : undefined);
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

  private async importScan(
    role: ScanRole,
    name: string,
    run: () => Promise<LoadedScan>,
    source: () => Promise<Blob>,
  ): Promise<void> {
    const store = useSceneStore.getState();
    const generation = (this.generation.get(role) ?? 0) + 1;
    this.generation.set(role, generation);
    const current = () => this.generation.get(role) === generation;
    store.upsertObject({ id: role, name, role });
    store.patchObject(role, { phase: 'processing' });
    try {
      const loaded = await run();
      if (!current()) return;
      const { sha256, stats } = loaded.payload;
      this.cache.set(sha256, { geometry: loaded.geometry, payload: loaded.payload });
      const blob = await source();
      this.sources.set(sha256, blob);
      let fileId: string | undefined;
      let uploadWarning: string | undefined;
      if (this.persistence) {
        store.patchObject(role, { phase: 'uploading' });
        try {
          fileId = await this.persistence.upload({ role, name, sha256, blob });
        } catch (e) {
          uploadWarning = `Not saved to the server: ${e instanceof Error ? e.message : String(e)}`;
        }
        if (!current()) return;
      }
      useDesignStore.getState().dispatch({
        type: 'addScan',
        scan: { role, name, mesh: { sha256, fileId, units: 'mm', frame: 'scan', triangleCount: stats.triangles } },
      });
      if (uploadWarning) {
        store.patchObject(role, { warnings: [...(useSceneStore.getState().objects.find((o) => o.id === role)?.warnings ?? []), uploadWarning] });
      }
    } catch (e) {
      if (isStale(e) || !current()) return; // superseded by a newer import for this role
      store.patchObject(role, { phase: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Make the viewer and the object list match `doc.scans`. */
  private reconcile(): void {
    const { doc } = useDesignStore.getState();
    const store = useSceneStore.getState();
    const isFirst = this.shown.size === 0;
    let changed = false;
    for (const role of ROLES) {
      const scan = doc.scans.find((s) => s.role === role);
      const cached = scan ? this.cache.get(scan.mesh.sha256) : undefined;
      const obj = store.objects.find((o) => o.id === role);
      if (scan && cached) {
        if (this.shown.get(role) === scan.mesh.sha256 && obj?.phase === 'ready' && this.viewer?.hasObject(role)) continue;
        if (!obj || obj.sha256 !== scan.mesh.sha256 || obj.phase !== 'ready') {
          const keepWarnings = obj?.sha256 === scan.mesh.sha256 ? obj.warnings : [];
          store.upsertObject({ id: role, name: scan.name, role });
          const { stats, warnings, bvhMs } = cached.payload;
          store.patchObject(role, {
            phase: 'ready',
            stats,
            warnings: [...new Set([...warnings, ...keepWarnings])],
            sha256: scan.mesh.sha256,
            bvhMs,
            hasColors: stats.hasColors,
          });
        }
        this.shown.set(role, scan.mesh.sha256);
        const ready = useSceneStore.getState().objects.find((o) => o.id === role);
        if (ready) this.addToViewer(ready, cached.geometry);
        changed = true;
      } else if (!scan && this.shown.has(role)) {
        // Removed from the document (removeScan or undo of addScan).
        if (obj?.phase === 'ready') this.dropObject(role);
        else {
          this.viewer?.removeObject(role);
          this.shown.delete(role);
        }
        changed = true;
      }
    }
    if (changed) {
      this.updateViewFrame();
      if (isFirst && this.shown.size > 0) this.viewer?.setView('buccal', false);
    }
  }

  private dropObject(role: ScanRole): void {
    this.viewer?.removeObject(role);
    this.shown.delete(role);
    useSceneStore.getState().removeObject(role);
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
    const jaws = [...this.shown.entries()].flatMap(([role, sha]) => {
      const g = this.cache.get(sha)?.geometry;
      const positions = g?.getAttribute('position')?.array;
      const normals = g?.getAttribute('normal')?.array;
      if (!(positions instanceof Float32Array) || !(normals instanceof Float32Array)) return [];
      return [{ role, positions, normals }];
    });
    const frame = estimateViewFrame(jaws);
    if (frame) this.viewer?.setViewFrame(frame);
  }
}

export const sceneController = new SceneController();

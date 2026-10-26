import type { ScanRole } from '@dcad/shared';
import { create } from 'zustand';
import type { ScanStats } from '../geometry/processScan';
import type { Projection } from '../engine/Viewer';

export type ImportPhase = 'reading' | 'processing' | 'uploading' | 'ready' | 'error';

export interface SceneObjectState {
  /** One object per scan role; the role doubles as the id. */
  id: ScanRole;
  name: string;
  role: ScanRole;
  phase: ImportPhase;
  error?: string;
  visible: boolean;
  opacity: number;
  useVertexColors: boolean;
  hasColors: boolean;
  stats?: ScanStats;
  warnings: string[];
  sha256?: string;
  /** BVH build time in the worker. */
  bvhMs?: number;
}

interface SceneState {
  objects: SceneObjectState[];
  projection: Projection;
  upsertObject(obj: Pick<SceneObjectState, 'id' | 'name' | 'role'>): void;
  patchObject(id: ScanRole, patch: Partial<SceneObjectState>): void;
  removeObject(id: ScanRole): void;
  setProjection(p: Projection): void;
}

export const useSceneStore = create<SceneState>()((set) => ({
  objects: [],
  projection: 'perspective',
  upsertObject: ({ id, name, role }) =>
    set((s) => {
      const fresh: SceneObjectState = {
        id,
        name,
        role,
        phase: 'reading',
        // The pre-op scan lies over the prepared jaw and hides the cavity: it starts hidden.
        visible: role !== 'preop',
        opacity: 1,
        useVertexColors: true,
        hasColors: false,
        warnings: [],
      };
      const exists = s.objects.some((o) => o.id === id);
      return { objects: exists ? s.objects.map((o) => (o.id === id ? fresh : o)) : [...s.objects, fresh] };
    }),
  patchObject: (id, patch) => set((s) => ({ objects: s.objects.map((o) => (o.id === id ? { ...o, ...patch } : o)) })),
  removeObject: (id) => set((s) => ({ objects: s.objects.filter((o) => o.id !== id) })),
  setProjection: (projection) => set({ projection }),
}));

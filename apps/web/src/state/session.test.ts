import type { DesignVersion } from '@dcad/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./sceneController', () => ({
  sceneController: {
    clear: vi.fn(),
    setPersistence: vi.fn(),
    loadScans: vi.fn(async () => {}),
    loadLocalScans: vi.fn(async () => {}),
    sourceFor: vi.fn(() => null),
  },
}));
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    me: vi.fn(),
    listCases: vi.fn(async () => []),
    getCase: vi.fn(),
    latestVersion: vi.fn(),
    saveVersion: vi.fn(),
    updateCase: vi.fn(),
    uploadFile: vi.fn(),
    downloadFile: vi.fn(),
  };
});
vi.mock('../api/auth', () => ({ getSession: vi.fn(async () => null), signIn: vi.fn(), signUp: vi.fn(), signOut: vi.fn() }));

const api = await import('../api/client');
const { sceneController } = await import('./sceneController');
const { useDesignStore } = await import('../design/store');
const { newDocument } = await import('../design/document');
const session = await import('./session');

const SHA = 'b'.repeat(64);
const NOW = '2026-10-11T10:00:00.000Z';
const setup = { patientRef: 'LAB-1', teeth: [{ fdi: 36, restoration: 'anatomic-crown' as const, material: 'zirconia' as const }], notes: '', connections: [] };
const record = { id: 'c1', patientRef: 'LAB-1', teeth: [36], status: 'draft' as const, currentVersion: 0, createdAt: NOW, updatedAt: NOW, setup };

beforeEach(() => {
  vi.clearAllMocks();
  useDesignStore.getState().load(newDocument(), 0);
  session.useSessionStore.setState({ status: 'cases', currentCase: null, offline: false, saveError: null, saveWarning: null, saving: false });
});

describe('session', () => {
  it('opens a never-saved case as a new document and routes uploads to it', async () => {
    vi.mocked(api.getCase).mockResolvedValue({ ...record, files: [] });
    vi.mocked(api.latestVersion).mockResolvedValue(null);
    await session.openCase('c1');
    const s = session.useSessionStore.getState();
    expect(s.status).toBe('editor');
    expect(s.currentCase?.id).toBe('c1');
    expect(useDesignStore.getState().doc.caseId).toBe('c1');
    expect(useDesignStore.getState().version).toBe(0);
    const persistence = vi.mocked(sceneController.setPersistence).mock.calls.at(-1)![0]!;
    vi.mocked(api.uploadFile).mockResolvedValue({ id: 'f9' } as never);
    expect(await persistence.upload({ role: 'lower', name: 'l.stl', sha256: SHA, blob: new Blob([]) })).toBe('f9');
    expect(vi.mocked(api.uploadFile).mock.calls[0]![1]).toMatchObject({ kind: 'lower', name: 'l.stl' });
  });

  it('opens the latest version and downloads its scans', async () => {
    const doc = useDesignStore.getState().dispatch({
      type: 'addScan',
      scan: { role: 'lower', name: 'l.stl', mesh: { sha256: SHA, fileId: 'f1', units: 'mm', frame: 'scan' } },
    });
    const version: DesignVersion = { caseId: 'c1', version: 4, parentVersion: 3, author: 'user', doc: { ...doc, caseId: 'c1' }, createdAt: NOW };
    vi.mocked(api.getCase).mockResolvedValue({ ...record, currentVersion: 4, files: [] });
    vi.mocked(api.latestVersion).mockResolvedValue(version);
    await session.openCase('c1');
    expect(useDesignStore.getState().version).toBe(4);
    expect(sceneController.loadScans).toHaveBeenCalledOnce();
    const [scans, fetchBytes] = vi.mocked(sceneController.loadScans).mock.calls[0]!;
    expect(scans.map((s) => s.mesh.fileId)).toEqual(['f1']);
    await fetchBytes(scans[0]!);
    expect(api.downloadFile).toHaveBeenCalledWith('f1');
  });

  it('saves with the current version as parent and promotes a draft case', async () => {
    session.useSessionStore.setState({ status: 'editor', currentCase: record });
    useDesignStore.getState().load(newDocument('c1', setup), 2);
    const doc = useDesignStore.getState().dispatch({
      type: 'addScan',
      scan: { role: 'lower', name: 'l.stl', mesh: { sha256: SHA, units: 'mm', frame: 'scan' } },
    });
    vi.mocked(api.saveVersion).mockResolvedValue({ caseId: 'c1', version: 3, parentVersion: 2, author: 'user', doc, createdAt: NOW });
    vi.mocked(api.updateCase).mockResolvedValue({ ...record, status: 'in-design', currentVersion: 3 });
    await session.save();
    expect(vi.mocked(api.saveVersion).mock.calls[0]![1]).toMatchObject({ parentVersion: 2, author: 'user' });
    expect(api.updateCase).toHaveBeenCalledWith('c1', { setup, status: 'in-design' });
    expect(useDesignStore.getState().version).toBe(3);
    expect(useDesignStore.getState().savedDoc).toBe(doc);
  });
});

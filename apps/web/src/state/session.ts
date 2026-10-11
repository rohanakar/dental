import type { CaseSetup, CaseSummary } from '@dcad/shared';
import { create } from 'zustand';
import * as auth from '../api/auth';
import * as api from '../api/client';
import { ApiRequestError, isUnavailable, type CaseRecord } from '../api/client';
import { newDocument } from '../design/document';
import { selectDirty, useDesignStore } from '../design/store';
import { downloadBytes } from '../io/exportCrown';
import { exportProject, importProject, type ProjectScan } from '../io/projectZip';
import { flushProposalEvents } from '../ai/events';
import { recordEditsOnSave } from '../ai/orchestrator';
import { useToolStore } from '../tools/toolStore';
import { sceneController } from './sceneController';

export type SessionStatus = 'checking' | 'signed-out' | 'cases' | 'editor';

export interface SessionState {
  status: SessionStatus;
  user: auth.AuthUser | null;
  /** Working without the backend: nothing is persisted. */
  offline: boolean;
  /** Shown on the sign-in screen, e.g. when the server is unreachable. */
  notice: string | null;
  authBusy: boolean;
  authError: string | null;
  cases: CaseSummary[];
  casesLoading: boolean;
  casesError: string | null;
  /** The open backend case (null offline). */
  currentCase: CaseRecord | null;
  opening: boolean;
  openError: string | null;
  saving: boolean;
  saveError: string | null;
  /** Non-blocking note from the last save (e.g. scans that never reached the server). */
  saveWarning: string | null;
  /** Building or reading a local project file. */
  projectBusy: boolean;
  projectError: string | null;
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const UNSAVED_PROMPT = 'You have unsaved changes. Leave this case and discard them?';
/** Recorded in project files. */
const APP_VERSION = '0.5.0';

export const useSessionStore = create<SessionState>()(() => ({
  status: 'checking',
  user: null,
  offline: false,
  notice: null,
  authBusy: false,
  authError: null,
  cases: [],
  casesLoading: false,
  casesError: null,
  currentCase: null,
  opening: false,
  openError: null,
  saving: false,
  saveError: null,
  saveWarning: null,
  projectBusy: false,
  projectError: null,
}));

const set = useSessionStore.setState;
const get = useSessionStore.getState;

/** Leave the current document: forget scans, stop uploading, start a blank local document. */
function resetWorkspace(): void {
  sceneController.clear();
  sceneController.setPersistence(null);
  useToolStore.getState().reset();
  useDesignStore.getState().load(newDocument(), 0);
  set({ currentCase: null, offline: false, saveError: null, saveWarning: null, openError: null });
}

/** Ask before discarding unsaved work. Offline documents are never saved, so they count as unsaved once edited. */
function confirmDiscard(): boolean {
  if (!selectDirty(useDesignStore.getState())) return true;
  return typeof window === 'undefined' || window.confirm(UNSAVED_PROMPT);
}

async function enterSignedIn(user: auth.AuthUser | null): Promise<void> {
  set({ user, status: 'cases', notice: null, authError: null });
  await refreshCases();
}

/** Check for an existing session. An unreachable API lands on the sign-in screen with an offline option. */
export async function init(): Promise<void> {
  set({ status: 'checking' });
  try {
    await api.me();
    const user = await auth.getSession().catch(() => null);
    await enterSignedIn(user);
  } catch (e) {
    let notice: string | null = null;
    if (isUnavailable(e)) notice = 'The server is unreachable. You can sign in once it is back, or continue offline.';
    else if (e instanceof ApiRequestError && e.code === 'no_organization') notice = 'Your account has no lab (organization).';
    else if (!(e instanceof ApiRequestError && e.status === 401)) notice = errorMessage(e);
    set({ status: 'signed-out', user: null, notice });
  }
}

async function authenticate(run: () => Promise<auth.AuthUser>): Promise<void> {
  set({ authBusy: true, authError: null });
  try {
    const user = await run();
    await api.me();
    await enterSignedIn(user);
  } catch (e) {
    set({ authError: errorMessage(e) });
  } finally {
    set({ authBusy: false });
  }
}

export const signIn = (email: string, password: string) => authenticate(() => auth.signIn(email, password));
export const signUp = (email: string, password: string, name: string) =>
  authenticate(() => auth.signUp(email, password, name));

export async function signOut(): Promise<void> {
  if (!confirmDiscard()) return;
  try {
    await auth.signOut();
  } catch {
    // The session may already be gone; sign out locally regardless.
  }
  resetWorkspace();
  set({ status: 'signed-out', user: null, cases: [], notice: null });
}

export async function refreshCases(): Promise<void> {
  set({ casesLoading: true, casesError: null });
  try {
    set({ cases: await api.listCases() });
  } catch (e) {
    set({ casesError: errorMessage(e) });
  } finally {
    set({ casesLoading: false });
  }
}

export async function createCase(setup: CaseSetup): Promise<void> {
  set({ opening: true, openError: null });
  try {
    const created = await api.createCase(setup);
    await openCase(created.id);
  } catch (e) {
    set({ openError: errorMessage(e), opening: false });
  }
}

/**
 * Open a backend case: load its latest design version (or a new document
 * from its setup), route scan uploads to it, and download its scans.
 */
export async function openCase(id: string): Promise<void> {
  set({ opening: true, openError: null });
  try {
    const [detail, latest] = await Promise.all([api.getCase(id), api.latestVersion(id)]);
    resetWorkspace();
    const doc = latest ? latest.doc : newDocument(detail.id, detail.setup);
    useDesignStore.getState().load(doc, latest?.version ?? 0);
    sceneController.setPersistence({
      upload: async ({ role, name, sha256, blob }) => (await api.uploadFile(detail.id, { kind: role, name, sha256, blob })).id,
    });
    const { files: _files, ...record } = detail;
    const missing = doc.scans.filter((s) => !s.mesh.fileId);
    set({
      currentCase: record,
      status: 'editor',
      opening: false,
      saveWarning: missing.length
        ? `${missing.map((s) => s.name).join(', ')} never reached the server and cannot be loaded. Import them again.`
        : null,
    });
    void flushProposalEvents();
    void sceneController.loadScans(
      doc.scans.filter((s) => s.mesh.fileId),
      (scan) => api.downloadFile(scan.mesh.fileId!),
    );
  } catch (e) {
    set({ openError: errorMessage(e), opening: false });
  }
}

/** Work without the backend. Nothing is saved. */
export function goOffline(): void {
  resetWorkspace();
  set({ offline: true, status: 'editor' });
}

/** Back to the case list (or the sign-in screen when offline without a session). */
export function backToCases(): void {
  if (!confirmDiscard()) return;
  resetWorkspace();
  if (get().user) {
    set({ status: 'cases' });
    void refreshCases();
  } else {
    set({ status: 'signed-out' });
  }
}

/** Save the document as a new version of the open case (optimistic concurrency). */
export async function save(): Promise<void> {
  const current = get().currentCase;
  if (!current || get().saving) return;
  const { doc, version, lastAuthor, transaction } = useDesignStore.getState();
  if (transaction) {
    set({ saveError: 'Accept or revert the open AI proposal before saving.' });
    return;
  }
  set({ saving: true, saveError: null });
  try {
    const saved = await api.saveVersion(current.id, { parentVersion: version, author: lastAuthor, doc });
    useDesignStore.getState().markSaved(saved.version, doc);
    recordEditsOnSave();
    void flushProposalEvents();
    const setupChanged = JSON.stringify(doc.setup) !== JSON.stringify(current.setup);
    let currentCase = { ...current, currentVersion: saved.version };
    if (setupChanged || current.status === 'draft') {
      currentCase = await api.updateCase(current.id, { setup: doc.setup, status: 'in-design' });
    }
    const missing = doc.scans.filter((s) => !s.mesh.fileId);
    set({
      currentCase,
      saveWarning: missing.length
        ? `Saved, but ${missing.map((s) => s.name).join(', ')} did not upload; reopening the case will not restore ${missing.length > 1 ? 'them' : 'it'}.`
        : null,
    });
  } catch (e) {
    if (e instanceof ApiRequestError && e.code === 'conflict') {
      const remote = (e.details as { currentVersion?: number } | undefined)?.currentVersion;
      set({
        saveError: `This case was saved elsewhere${remote ? ` (now version ${remote})` : ''}. Reopen it from the case list to continue; unsaved changes here will be lost.`,
      });
    } else {
      set({ saveError: errorMessage(e) });
    }
  } finally {
    set({ saving: false });
  }
}

/**
 * Download the open design as a local project file (`<ref>.dcad.zip`):
 * the document plus the original scan bytes. Scans this tab never held
 * (opened from a case but not yet downloaded) are fetched from the backend.
 */
export async function downloadProject(): Promise<void> {
  const { doc } = useDesignStore.getState();
  set({ projectBusy: true, projectError: null });
  try {
    const scans: ProjectScan[] = [];
    for (const ref of doc.scans) {
      let blob = sceneController.sourceFor(ref.mesh.sha256);
      if (!blob && ref.mesh.fileId && get().currentCase) blob = new Blob([await api.downloadFile(ref.mesh.fileId)]);
      if (!blob) throw new Error(`The ${ref.role} scan (${ref.name}) is not available in this tab; import it again`);
      scans.push({ ref, bytes: new Uint8Array(await blob.arrayBuffer()) });
    }
    const zip = exportProject({ doc, scans, appVersion: APP_VERSION });
    const name = (doc.setup.patientRef || get().currentCase?.patientRef || 'case').replace(/[^\w.-]+/g, '_');
    downloadBytes(zip, `${name}.dcad.zip`, 'application/zip');
  } catch (e) {
    set({ projectError: `Could not build the project file: ${errorMessage(e)}` });
  } finally {
    set({ projectBusy: false });
  }
}

/**
 * Open a local project file in offline mode. The file is read and verified
 * before the current workspace is discarded, so a bad file changes nothing.
 */
export async function openProject(file: File): Promise<void> {
  if (!confirmDiscard()) return;
  set({ projectBusy: true, projectError: null });
  try {
    const project = await importProject(new Uint8Array(await file.arrayBuffer()));
    resetWorkspace();
    useDesignStore.getState().load(project.doc, 0);
    set({ offline: true, status: 'editor' });
    void sceneController.loadLocalScans(project.scans);
  } catch (e) {
    set({ projectError: `Could not open ${file.name}: ${errorMessage(e)}` });
  } finally {
    set({ projectBusy: false });
  }
}

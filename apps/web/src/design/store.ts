import { Command, type DesignDocument, type StepId } from '@dcad/shared';
import type { z } from 'zod';
import type { VersionAuthor } from '@dcad/shared';
import { create } from 'zustand';
import { newDocument } from './document';
import { applyCommands } from './reducer';

const HISTORY_LIMIT = 100;

export type Author = z.infer<typeof VersionAuthor>;

/** Open transaction: dispatches update `doc` live but add no history until commit. */
export interface DesignTransaction {
  label: string;
  author: Exclude<Author, 'user'>;
  /** Document before the transaction (restored by rollback, pushed as one undo entry on commit). */
  base: DesignDocument;
  startedAt: number;
}

export interface DesignState {
  doc: DesignDocument;
  /** Undo stack of immutable snapshots (oldest first). */
  past: DesignDocument[];
  future: DesignDocument[];
  /** Backend version this document is based on (0 = never saved). */
  version: number;
  /** Snapshot that matches the backend; `doc !== savedDoc` means unsaved changes. */
  savedDoc: DesignDocument;
  activeFdi: number;
  activeStep: StepId;
  transaction: DesignTransaction | null;
  /** Who made the last committed change (saved versions record it). */
  lastAuthor: Author;
  /**
   * Validate and apply commands. A batch is one undo entry. Throws a ZodError
   * for invalid input and a CommandError for commands that do not apply.
   */
  dispatch(cmds: Command | Command[]): DesignDocument;
  undo(): void;
  redo(): void;
  /** Start an agent/proposer transaction. Throws if one is already open. */
  beginTransaction(opts: { label: string; author: Exclude<Author, 'user'> }): void;
  /** Keep the transaction's changes as one undo entry. Returns the document. */
  commitTransaction(): DesignDocument;
  /** Discard the transaction's changes. */
  rollbackTransaction(): void;
  /** Replace the document (open a case); clears history. */
  load(doc: DesignDocument, version: number): void;
  markSaved(version: number, doc: DesignDocument): void;
  setActiveFdi(fdi: number): void;
  setActiveStep(step: StepId): void;
}

const firstFdi = (doc: DesignDocument, preferred?: number): number =>
  doc.teeth.find((t) => t.fdi === preferred)?.fdi ?? doc.teeth[0]?.fdi ?? 36;

const initial = newDocument();

export const useDesignStore = create<DesignState>()((set, get) => ({
  doc: initial,
  past: [],
  future: [],
  version: 0,
  savedDoc: initial,
  activeFdi: firstFdi(initial),
  activeStep: 'scans',
  transaction: null,
  lastAuthor: 'user',
  dispatch(input) {
    const cmds = (Array.isArray(input) ? input : [input]).map((c) => Command.parse(c));
    const { doc, past, activeFdi, transaction } = get();
    const next = applyCommands(doc, cmds);
    if (next === doc) return doc;
    if (transaction) {
      set({ doc: next, activeFdi: firstFdi(next, activeFdi) });
      return next;
    }
    set({
      doc: next,
      past: [...past, doc].slice(-HISTORY_LIMIT),
      future: [],
      activeFdi: firstFdi(next, activeFdi),
      lastAuthor: 'user',
    });
    return next;
  },
  beginTransaction({ label, author }) {
    if (get().transaction) throw new Error(`A transaction is already open (${get().transaction!.label})`);
    set({ transaction: { label, author, base: get().doc, startedAt: performance.now() } });
  },
  commitTransaction() {
    const { transaction, doc, past } = get();
    if (!transaction) throw new Error('No open transaction');
    if (doc === transaction.base) {
      set({ transaction: null });
      return doc;
    }
    set({ transaction: null, past: [...past, transaction.base].slice(-HISTORY_LIMIT), future: [], lastAuthor: transaction.author });
    return doc;
  },
  rollbackTransaction() {
    const { transaction, activeFdi } = get();
    if (!transaction) return;
    set({ transaction: null, doc: transaction.base, activeFdi: firstFdi(transaction.base, activeFdi) });
  },
  undo() {
    if (get().transaction) return; // accept or revert the open transaction first
    const { past, doc, future, activeFdi } = get();
    const prev = past.at(-1);
    if (!prev) return;
    set({ doc: prev, past: past.slice(0, -1), future: [doc, ...future], activeFdi: firstFdi(prev, activeFdi) });
  },
  redo() {
    if (get().transaction) return;
    const { past, doc, future, activeFdi } = get();
    const next = future[0];
    if (!next) return;
    set({ doc: next, past: [...past, doc], future: future.slice(1), activeFdi: firstFdi(next, activeFdi) });
  },
  load(doc, version) {
    set({ doc, savedDoc: doc, version, past: [], future: [], activeFdi: firstFdi(doc), transaction: null, lastAuthor: 'user' });
  },
  markSaved(version, doc) {
    set({ version, savedDoc: doc });
  },
  setActiveFdi(fdi) {
    set({ activeFdi: firstFdi(get().doc, fdi) });
  },
  setActiveStep(activeStep) {
    set({ activeStep });
  },
}));

export const selectActiveTooth = (s: DesignState) => s.doc.teeth.find((t) => t.fdi === s.activeFdi);
export const selectDirty = (s: DesignState) => s.doc !== s.savedDoc;

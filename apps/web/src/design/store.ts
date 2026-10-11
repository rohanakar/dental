import { Command, type DesignDocument, type StepId } from '@dcad/shared';
import { create } from 'zustand';
import { newDocument } from './document';
import { applyCommands } from './reducer';

const HISTORY_LIMIT = 100;

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
  /**
   * Validate and apply commands. A batch is one undo entry. Throws a ZodError
   * for invalid input and a CommandError for commands that do not apply.
   */
  dispatch(cmds: Command | Command[]): DesignDocument;
  undo(): void;
  redo(): void;
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
  dispatch(input) {
    const cmds = (Array.isArray(input) ? input : [input]).map((c) => Command.parse(c));
    const { doc, past, activeFdi } = get();
    const next = applyCommands(doc, cmds);
    if (next === doc) return doc;
    set({
      doc: next,
      past: [...past, doc].slice(-HISTORY_LIMIT),
      future: [],
      activeFdi: firstFdi(next, activeFdi),
    });
    return next;
  },
  undo() {
    const { past, doc, future, activeFdi } = get();
    const prev = past.at(-1);
    if (!prev) return;
    set({ doc: prev, past: past.slice(0, -1), future: [doc, ...future], activeFdi: firstFdi(prev, activeFdi) });
  },
  redo() {
    const { past, doc, future, activeFdi } = get();
    const next = future[0];
    if (!next) return;
    set({ doc: next, past: [...past, doc], future: future.slice(1), activeFdi: firstFdi(next, activeFdi) });
  },
  load(doc, version) {
    set({ doc, savedDoc: doc, version, past: [], future: [], activeFdi: firstFdi(doc) });
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

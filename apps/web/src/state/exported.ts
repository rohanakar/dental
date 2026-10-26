import type { DesignDocument } from '@dcad/shared';
import { create } from 'zustand';
import { useDesignStore } from '../design/store';

/**
 * What this session last exported for milling: the document as it was and the teeth it covered. Finalize counts as
 * done for those teeth while the document is unchanged; any edit (a new document) makes it open again.
 */
export const useExported = create<{ doc: DesignDocument | null; teeth: readonly number[]; file: string | null }>(() => ({ doc: null, teeth: [], file: null }));

export function markExported(teeth: readonly number[], file: string): void {
  useExported.setState({ doc: useDesignStore.getState().doc, teeth: [...teeth], file });
}

/** Whether `fdi` was exported from the current document. */
export function useIsExported(fdi: number): boolean {
  const covered = useExported((e) => e.teeth.includes(fdi));
  const exportedDoc = useExported((e) => e.doc);
  const doc = useDesignStore((s) => s.doc);
  return covered && exportedDoc === doc;
}

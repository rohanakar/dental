import { type CaseSetup, type DesignDocument, isCavityRestoration, outerSourceOf } from '@dcad/shared';
import { sceneController } from '../state/sceneController';
import type { InlayRequest } from '../workers/analysisTypes';

/** The tooth is an inlay or onlay in the case setup. */
export const isCavity = (setup: Pick<CaseSetup, 'teeth'>, fdi: number): boolean => {
  const restoration = setup.teeth.find((t) => t.fdi === fdi)?.restoration;
  return restoration !== undefined && isCavityRestoration(restoration);
};

/** The case's pre-op scan, once it is loaded (the worker has it then). */
export function loadedPreopSha(doc: Pick<DesignDocument, 'scans'>): string | undefined {
  const sha = doc.scans.find((s) => s.role === 'preop')?.mesh.sha256;
  return sha && sceneController.geometryFor('preop')?.sha256 === sha ? sha : undefined;
}

/**
 * The worker request fields of an inlay or onlay: its type, the outer source in use and the pre-op scan. Undefined for
 * other teeth, so it can be spread into any request.
 */
export function inlayRequestOf(doc: Pick<DesignDocument, 'setup' | 'scans' | 'teeth'>, fdi: number): InlayRequest | undefined {
  const restoration = doc.setup.teeth.find((t) => t.fdi === fdi)?.restoration;
  if (restoration !== 'inlay' && restoration !== 'onlay') return undefined;
  const source = outerSourceOf(doc, fdi);
  const preopSha = source === 'preop' ? loadedPreopSha(doc) : undefined;
  return { type: restoration, source, ...(preopSha ? { preopSha } : {}) };
}

/** What an inlay request depends on, as primitives (for the tools' recompute keys). */
export const inlayKey = (doc: Pick<DesignDocument, 'setup' | 'scans' | 'teeth'>, fdi: number): string => {
  const r = inlayRequestOf(doc, fdi);
  return r ? `${r.type}:${r.source}:${r.preopSha ?? ''}` : '';
};

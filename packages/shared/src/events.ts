import { z } from 'zod';
import { DesignParams, Fdi } from './case';
import { StepId } from './design';
import { MeshRef, Sha256 } from './geometry';
import { ProposerId } from './proposer';

/**
 * A proposal and what the user finally accepted. Stores artifact references
 * (not just counts) so every event is a training example for future models.
 */
export const Artifact = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('json'), value: z.unknown() }),
  z.object({ kind: z.literal('mesh'), mesh: MeshRef }),
]);
export type Artifact = z.infer<typeof Artifact>;

export const ProposalEvent = z.object({
  caseId: z.string(),
  fdi: Fdi,
  step: StepId,
  proposerId: ProposerId,
  inputSnapshot: z.object({
    scanHashes: z.array(Sha256),
    params: DesignParams,
    appVersion: z.string(),
    docVersion: z.number().int().nonnegative(),
  }),
  proposal: Artifact,
  finalAccepted: Artifact.optional(),
  action: z.enum(['accepted', 'edited', 'rejected']),
  editsCount: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
});
export type ProposalEvent = z.infer<typeof ProposalEvent>;

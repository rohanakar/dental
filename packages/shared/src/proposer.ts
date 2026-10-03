import { z } from 'zod';
import { DesignParams, Fdi } from './case';
import { StepId } from './design';
import { MeshRef } from './geometry';

/**
 * Proposer contract — the AI extension point. One proposer per design step.
 * Implementations: `classical.*` (in-browser algorithms), `ml.*` (HTTP jobs on
 * a GPU service), `llm.*` (text/vision). All are async jobs so a remote model
 * and a local algorithm look the same to the orchestrator.
 */

/** e.g. "classical.livewire-margin@1", "ml.margin-unet@0.3.1" */
export const ProposerId = z.string().regex(/^(classical|ml|llm)\.[a-z0-9-]+@[0-9][0-9a-z.-]*$/);
export type ProposerId = z.infer<typeof ProposerId>;

export const QaCheck = z.object({
  id: z.string(),
  passed: z.boolean(),
  value: z.number().optional(),
  threshold: z.number().optional(),
  message: z.string(),
});
export type QaCheck = z.infer<typeof QaCheck>;

export const ProposalInput = z.object({
  caseId: z.string(),
  fdi: Fdi,
  step: StepId,
  /** Document version the proposal is computed against. */
  docVersion: z.number().int().nonnegative(),
  /** Scans and other meshes the proposer needs, content-addressed. */
  meshes: z.record(z.string(), MeshRef),
  params: DesignParams,
  /** Step-specific inputs (e.g. clicked seed point), validated by the proposer. */
  hints: z.record(z.string(), z.unknown()).default({}),
});
export type ProposalInput = z.infer<typeof ProposalInput>;

export const ProposalResult = z.object({
  proposerId: ProposerId,
  /** Hash of model weights for ml.* proposers; omitted for classical ones. */
  modelHash: z.string().optional(),
  /** Step-specific output; validated against the step's output schema by the consumer. */
  output: z.unknown(),
  qa: z.array(QaCheck),
  rationale: z.string().optional(),
});
export type ProposalResult = z.infer<typeof ProposalResult>;

export const JobState = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export type JobState = z.infer<typeof JobState>;

export const ProposalJobRequest = z.object({
  proposerId: ProposerId,
  input: ProposalInput,
});
export type ProposalJobRequest = z.infer<typeof ProposalJobRequest>;

export const ProposalJobStatus = z.object({
  jobId: z.string(),
  state: JobState,
  progress: z.number().min(0).max(1),
  result: ProposalResult.optional(),
  error: z.string().optional(),
});
export type ProposalJobStatus = z.infer<typeof ProposalJobStatus>;

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
  /** Unit of value, threshold and tolerance; a fraction (0–1) reads as a percentage. Unset: a count. */
  unit: z.enum(['mm', 'mm2', 'um', 'deg', 'fraction']).optional(),
  /** The side of the threshold that passes: at least it (min) or at most it (max). Unset: a plain limit. */
  bound: z.enum(['min', 'max']).optional(),
  /** Measuring tolerance: a value this far past the threshold still passes. */
  tolerance: z.number().nonnegative().optional(),
  message: z.string(),
});
export type QaCheck = z.infer<typeof QaCheck>;

/** A number keeps its unit, and a limit word its number, on one line (no-break spaces). */
const UNIT_TEXT = { mm: '\u00a0mm', mm2: '\u00a0mm²', um: '\u00a0µm', deg: '°', fraction: '%' } as const;

/**
 * A check's measurement in words, e.g. "1.01 mm, minimum 0.50 mm, 0.02 mm measuring tolerance", "42.79°, maximum
 * 120°", "100%, minimum 75%" or "0, limit 0". Millimetres take two decimals (as the parameters do), anything below
 * 0.01 two significant digits. Empty without a value.
 */
export function qaValueText(c: QaCheck): string {
  if (c.value === undefined) return '';
  const show = (v: number): string => {
    if (c.unit === 'fraction') return `${Math.round(v * 100)}%`;
    const small = v !== 0 && Math.abs(v) < 0.01;
    const digits = small ? String(Number(v.toPrecision(2))) : c.unit === 'mm' ? v.toFixed(2) : String(Number(v.toFixed(2)));
    return `${digits}${c.unit ? UNIT_TEXT[c.unit] : ''}`;
  };
  const parts = [show(c.value)];
  if (c.threshold !== undefined) parts.push(`${c.bound === 'min' ? 'minimum' : c.bound === 'max' ? 'maximum' : 'limit'}\u00a0${show(c.threshold)}`);
  if (c.tolerance) parts.push(`${show(c.tolerance)} measuring tolerance`);
  return parts.join(', ');
}

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

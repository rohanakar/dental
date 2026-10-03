import { z } from 'zod';
import { CaseSetup, DesignParams, Fdi } from './case';
import { MeshRef, Pose, Vec3 } from './geometry';

export const SCHEMA_VERSION = 1 as const;

export const ScanRole = z.enum(['upper', 'lower', 'preop']);
export type ScanRole = z.infer<typeof ScanRole>;

export const ScanRef = z.object({
  role: ScanRole,
  mesh: MeshRef,
  /** Original file name, for display only. */
  name: z.string().max(256),
});
export type ScanRef = z.infer<typeof ScanRef>;

export const Source = z.enum(['auto', 'manual', 'agent']);
export type Source = z.infer<typeof Source>;

/** Tooth-local frame. All three axes are unit vectors and mutually orthogonal. */
export const ToothFrame = z.object({
  origin: Vec3,
  /** Points from the prep toward the antagonist. */
  occlusal: Vec3,
  /** Points toward the mesial neighbour. */
  mesial: Vec3,
  /** Points toward the cheek (buccal/vestibular). */
  buccal: Vec3,
  mesialContact: Vec3.optional(),
  distalContact: Vec3.optional(),
  source: Source,
});
export type ToothFrame = z.infer<typeof ToothFrame>;

/**
 * Margin as 3D points on the prep surface. faceHint is only a lookup
 * accelerator: face indices are not stable across re-imports or BVH builds.
 */
export const MarginPoint = z.object({
  p: Vec3,
  faceHint: z.number().int().nonnegative().optional(),
});
export const MarginLine = z.object({
  /** User-placed control points (live-wire anchors), in order around the prep. */
  anchors: z.array(MarginPoint).min(3),
  /** Dense resampled closed curve derived from the anchors. */
  points: z.array(MarginPoint),
  source: Source,
});
export type MarginLine = z.infer<typeof MarginLine>;

export const InsertionAxis = z.object({
  direction: Vec3,
  source: Source,
});
export type InsertionAxis = z.infer<typeof InsertionAxis>;

/**
 * Crown geometry is either a library template deformed onto the margin
 * (classical pipeline) or an arbitrary mesh (e.g. produced by an ML model).
 */
export const TemplateCrown = z.object({
  kind: z.literal('template'),
  templateId: z.string(),
  /** Pose of the template in the tooth frame. */
  pose: Pose,
  /** Sculpt/adapt displacements stored in the crown's local frame. */
  deltas: MeshRef.optional(),
});
export const MeshCrown = z.object({
  kind: z.literal('mesh'),
  mesh: MeshRef,
});
export const Crown = z.discriminatedUnion('kind', [TemplateCrown, MeshCrown]);
export type Crown = z.infer<typeof Crown>;

export const StepId = z.enum([
  'setup',
  'scans',
  'frame',
  'margin',
  'axis',
  'params',
  'proposal',
  'adapt',
  'finalize',
]);
export type StepId = z.infer<typeof StepId>;
export const STEP_ORDER: readonly StepId[] = StepId.options;

export const StepStatus = z.enum(['pending', 'done', 'stale']);
export type StepStatus = z.infer<typeof StepStatus>;

/** Exhaustive by design: every tooth tracks all steps. Start from initialSteps(). */
export const initialSteps = (): Record<StepId, StepStatus> =>
  Object.fromEntries(STEP_ORDER.map((s) => [s, 'pending'])) as Record<StepId, StepStatus>;

export const ToothDesign = z.object({
  fdi: Fdi,
  params: DesignParams,
  frame: ToothFrame.optional(),
  margin: MarginLine.optional(),
  axis: InsertionAxis.optional(),
  crown: Crown.optional(),
  steps: z.record(StepId, StepStatus),
});
export type ToothDesign = z.infer<typeof ToothDesign>;

export const DesignDocument = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  caseId: z.string(),
  setup: CaseSetup,
  scans: z.array(ScanRef),
  teeth: z.array(ToothDesign),
});
export type DesignDocument = z.infer<typeof DesignDocument>;

/**
 * Steps downstream of a changed step become stale and must be re-run.
 * Returns the steps invalidated by a change to `changed`.
 */
export function downstreamSteps(changed: StepId): StepId[] {
  const i = STEP_ORDER.indexOf(changed);
  return STEP_ORDER.slice(i + 1);
}

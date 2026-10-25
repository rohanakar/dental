import { STEP_ORDER, type StepId, type StepStatus } from '@dcad/shared';

type Statuses = Partial<Record<StepId, StepStatus>>;

/**
 * Steps a crown cannot do without. Setup and parameters start from defaults,
 * adapt is recommended but optional, and finalize is where the flow ends.
 * Each function takes the unit's own step list (`stepsFor(unitKind(...))`):
 * a pontic has no margin or axis, which stay pending in its statuses forever.
 */
export const REQUIRED: readonly StepId[] = ['scans', 'frame', 'margin', 'axis', 'proposal'];

/** Where an opened case picks up: the first step from scans to adapt that is not done (pending or stale). */
export function resumeStep(statuses: Statuses | undefined, steps: readonly StepId[] = STEP_ORDER): StepId {
  const order = [...REQUIRED, 'adapt' as const].filter((s) => steps.includes(s));
  return order.find((s) => statuses?.[s] !== 'done') ?? 'finalize';
}

/** The first required step before `step` that has never been done; a stale step still has its result. */
export function missingBefore(step: StepId, statuses: Statuses | undefined, steps: readonly StepId[] = STEP_ORDER): StepId | undefined {
  const index = STEP_ORDER.indexOf(step);
  return REQUIRED.find((s) => steps.includes(s) && STEP_ORDER.indexOf(s) < index && (statuses?.[s] ?? 'pending') === 'pending');
}

/** The steps either side of `step` in the unit's wizard. */
export function neighbours(step: StepId, steps: readonly StepId[] = STEP_ORDER): { prev?: StepId; next?: StepId } {
  const index = steps.indexOf(step);
  return index < 0 ? {} : { prev: steps[index - 1], next: steps[index + 1] };
}

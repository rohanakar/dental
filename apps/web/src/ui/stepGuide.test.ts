import { initialSteps, stepsFor } from '@dcad/shared';
import { describe, expect, it } from 'vitest';
import { missingBefore, neighbours, resumeStep } from './stepGuide';

describe('step guide', () => {
  it('resumes at the first unfinished step and points at the first missing prerequisite', () => {
    const fresh = initialSteps();
    expect(resumeStep(fresh)).toBe('scans');
    expect(missingBefore('margin', fresh)).toBe('scans');
    expect(missingBefore('scans', fresh)).toBeUndefined();

    // Margin is stale after a frame edit: resume there, but it still counts as present for later steps.
    const edited = { ...fresh, scans: 'done', frame: 'done', margin: 'stale', axis: 'done' } as const;
    expect(resumeStep(edited)).toBe('margin');
    expect(missingBefore('proposal', edited)).toBeUndefined();
    expect(missingBefore('finalize', edited)).toBe('proposal');

    const designed = { ...edited, margin: 'done', proposal: 'done', adapt: 'done' } as const;
    expect(resumeStep(designed)).toBe('finalize');

    // A pontic has no margin or axis: they never count as missing, and the wizard skips them.
    const pontic = stepsFor('pontic');
    const framed = { ...fresh, scans: 'done', frame: 'done' } as const;
    expect(resumeStep(framed, pontic)).toBe('proposal');
    expect(missingBefore('adapt', framed, pontic)).toBe('proposal');
    expect(neighbours('frame', pontic).next).toBe('params');
  });
});

import { bridgeOf, type DesignDocument, type ToothDesign, unitKind } from '@dcad/shared';
import { useMemo } from 'react';
import { useDesignStore } from '../../design/store';
import { marginProblems, type MarginProblems } from '../../tools/marginCheck';
import './MarginIssues.css';

/** The problems of a tooth's closed margin (null when it has none, or no margin). */
function problemsOf(tooth: ToothDesign | undefined): MarginProblems | null {
  if (!tooth?.margin || tooth.margin.points.length < 3) return null;
  const problems = marginProblems(
    tooth.margin.points.map((m) => m.p),
    { fdi: tooth.fdi, frame: tooth.frame },
  );
  return problems.failed.length > 0 ? problems : null;
}

/** The problems of the margin of `fdi` in a document (null when it has none, or no margin). */
export const marginProblemsOf = (doc: DesignDocument, fdi: number): MarginProblems | null => problemsOf(doc.teeth.find((t) => t.fdi === fdi));

/** One line per problem, with its value and the limit. */
function problemLines(p: MarginProblems): string[] {
  const lines = p.kinks.map(
    (k) => `Kink${k.side ? ` on the ${k.side} side` : ''}: the line turns ${k.turnDeg.toFixed(0)}° within 0.6 mm (at most 120°), so it doubles back.`,
  );
  if (p.failed.some((c) => c.id === 'margin.length')) lines.push(`Length ${p.lengthMm.toFixed(1)} mm, outside the plausible 8–60 mm.`);
  return lines;
}

/**
 * Margin step: what is wrong with the margin just closed, and how to fix it. The kinks are marked in the viewport
 * (DesignTools.drawOverlays).
 */
export function MarginWarning({ fdi }: { fdi: number }) {
  const tooth = useDesignStore((s) => s.doc.teeth.find((t) => t.fdi === fdi));
  const problems = useMemo(() => problemsOf(tooth), [tooth]);
  if (!problems) return null;
  return (
    <div className="warning margin-problems" role="status">
      <strong>The crown would fold at this margin.</strong>
      <ul>
        {problemLines(problems).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <span>
        {problems.kinks.length > 0
          ? 'Drag the nearest point onto the margin, or click on the prep to trace it again with more points near the red mark.'
          : 'Click on the prep to trace the margin again.'}
      </span>
    </div>
  );
}

/**
 * Proposal step: the open margin problems of the teeth the proposal builds on (the active tooth, or every abutment of
 * its bridge). A soft notice: proposing is still allowed.
 */
export function MarginNotice() {
  const doc = useDesignStore((s) => s.doc);
  const activeFdi = useDesignStore((s) => s.activeFdi);
  const open = useMemo(() => {
    const bridge = bridgeOf(doc, activeFdi);
    const teeth = bridge ? bridge.teeth.filter((f) => unitKind(doc.setup, f) === 'abutment') : [activeFdi];
    return teeth.flatMap((fdi) => {
      const problems = marginProblemsOf(doc, fdi);
      return problems ? [{ fdi, problems }] : [];
    });
  }, [doc, activeFdi]);
  if (open.length === 0) return null;
  const fix = (fdi: number) => {
    const store = useDesignStore.getState();
    store.setActiveFdi(fdi);
    store.setActiveStep('margin');
  };
  return (
    <div className="warning margin-problems" role="status">
      <strong>Margin problems: the crown follows the margin, so it would fold there.</strong>
      <ul>
        {open.map(({ fdi, problems }) => (
          <li key={fdi}>
            {fdi}: {problemLines(problems).join(' ')}{' '}
            <button type="button" className="link-btn" onClick={() => fix(fdi)}>
              Fix the margin of {fdi}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

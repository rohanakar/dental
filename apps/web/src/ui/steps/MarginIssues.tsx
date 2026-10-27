import { bridgeOf, type DesignDocument, type QaCheck, type ToothDesign, unitKind } from '@dcad/shared';
import { useMemo } from 'react';
import { useDesignStore } from '../../design/store';
import { marginProblems, type MarginProblems } from '../../tools/marginCheck';
import './MarginIssues.css';
import { isWing } from '../../tools/wing';
import { isCavity } from '../../tools/inlay';
import { marginKey } from '../../tools/marginLine';
import { useToolStore } from '../../tools/toolStore';

/**
 * The problems of a tooth's closed margin (null when it has none, or no margin). A natural tooth's gum line turns
 * sharply at the papillae by nature, so it is held to the length only; its doubt checks show instead (GumLineDoubt).
 */
function problemsOf(tooth: ToothDesign | undefined): MarginProblems | null {
  if (!tooth?.margin || tooth.margin.points.length < 3) return null;
  const problems = marginProblems(
    tooth.margin.points.map((m) => m.p),
    { fdi: tooth.fdi, frame: tooth.frame },
  );
  if (tooth.margin.line === 'gum') {
    const failed = problems.failed.filter((c) => c.id === 'margin.length');
    return failed.length > 0 ? { ...problems, failed, kinks: [] } : null;
  }
  return problems.failed.length > 0 ? problems : null;
}

/** The problems of the margin of `fdi` in a document (null when it has none, or no margin). */
export const marginProblemsOf = (doc: DesignDocument, fdi: number): MarginProblems | null =>
  // A Maryland wing's outline has corners by design: its Finalize row checks it instead (WingPanel).
  isWing(doc.setup, fdi) ? null : problemsOf(doc.teeth.find((t) => t.fdi === fdi));

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
  const wing = useDesignStore((s) => isWing(s.doc.setup, fdi));
  // A cavity margin gets the same check: its box corners turn about 90° over their fillets, never back on themselves.
  const unit = useDesignStore((s) => (isCavity(s.doc.setup, fdi) ? s.doc.setup.teeth.find((t) => t.fdi === fdi)!.restoration : 'crown'));
  const problems = useMemo(() => problemsOf(tooth), [tooth]);
  if (!problems || wing) return null;
  return (
    <div className="warning margin-problems" role="status">
      <strong>The {unit} would fold at this margin.</strong>
      <ul>
        {problemLines(problems).map((line, i) => (
          // Two kinks on the same side read the same.
          <li key={i}>{line}</li>
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

/** A failed gum-line check, said as what is wrong. */
function doubtReason(c: QaCheck): string {
  const v = c.value ?? 0;
  switch (c.id) {
    case 'margin.agree':
      return `Two ways of tracing it differ by ${v.toFixed(2)} mm on average (a clear line: under ${c.threshold} mm).`;
    case 'margin.round':
      return `It is short for this tooth (${v.toFixed(2)}× its usual outline): it may cut across the tooth.`;
    case 'margin.closed':
      return 'It does not close round the tooth.';
    case 'margin.length':
      return `Its length, ${v.toFixed(1)} mm, is outside the plausible 8–60 mm.`;
    default:
      return c.message;
  }
}

/**
 * Margin step: a gum line found automatically that its doubt checks flag (qa.ts gumLineGate), while it is unchanged:
 * which check failed, and how to fix it.
 */
export function GumLineDoubt({ fdi }: { fdi: number }) {
  const margin = useDesignStore((s) => s.doc.teeth.find((t) => t.fdi === fdi)?.margin);
  const doubt = useToolStore((s) => s.gumLineChecks);
  if (margin?.line !== 'gum' || !doubt || doubt.fdi !== fdi || doubt.key !== marginKey(margin.points)) return null;
  const reasons = doubt.checks.filter((c) => !c.passed).map(doubtReason);
  if (reasons.length === 0) return null;
  return (
    <div className="warning margin-problems" role="status">
      <strong>This gum line may be off in places.</strong>
      <ul>
        {reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      <span>Look along it; where it is off, use Redraw a section.</span>
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

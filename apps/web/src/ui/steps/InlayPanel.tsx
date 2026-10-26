import { type CaseSetup, normalizeConnections, outerSourceOf, type OuterSource, RESTORATION_ROLE } from '@dcad/shared';
import { useDesignStore } from '../../design/store';
import { followsPreop } from '../../design/inlay';
import { crownTool } from '../../tools/crownTool';
import { isCavity } from '../../tools/inlay';
import { userEdit } from '../../tools/nudge';
import { useToolStore } from '../../tools/toolStore';
import type { CrownResult } from '../../workers/analysisTypes';
import { BridgeConnectors, BridgeResultPanel, useActiveBridge } from './BridgePanels';
import { CrownStatusView } from './CrownStatusView';
import { FocusControls, MapSelect } from './CrownViewControls';
import type { ReadinessItem } from './readiness';

/**
 * Inlays and onlays in the editor (specs/2026-10-25-inlay-bridges.md): the restoration types in Setup, the outer
 * source switch (pre-op scan or library tooth), the Adapt panel (margin fit, isthmus, library fit) and the Finalize
 * rows. The steps hook in with one line each; the logic lives here. The "Cavity margin" label is WingPanel's
 * stepLabelFor.
 */

type InlayReport = NonNullable<CrownResult['inlay']>;
type CavityType = 'inlay' | 'onlay';

/** The tooth's cavity restoration type, or null. */
export const cavityTypeOf = (setup: Pick<CaseSetup, 'teeth'>, fdi: number): CavityType | null =>
  isCavity(setup, fdi) ? (setup.teeth.find((t) => t.fdi === fdi)!.restoration as CavityType) : null;

/** The active tooth's cavity restoration type, or null. */
export const useCavityType = (): CavityType | null => useDesignStore((s) => cavityTypeOf(s.doc.setup, s.activeFdi));

// ---- Setup ------------------------------------------------------------------------------------------

/** Make a tooth an inlay or onlay: connections it cannot have (to crowns and wings) are dropped. */
export function setCavity(setup: CaseSetup, fdi: number, type: CavityType): CaseSetup {
  const teeth = setup.teeth.map((t) => (t.fdi === fdi ? { ...t, restoration: type } : t));
  const order = new Map(teeth.map((t) => [t.fdi, t] as const));
  const allowed = RESTORATION_ROLE[type].connectsTo!;
  const kept = setup.connections.filter(([a, b]) => !(a === fdi || b === fdi) || allowed.includes(order.get(a === fdi ? b : a)!.restoration));
  return { ...setup, teeth, connections: normalizeConnections(kept) };
}

/** "Inlay" and "Onlay" in a unit's restoration switch (single restorations or inlay-bridge retainers). */
export function InlayButtons({ setup, fdi, commit }: { setup: CaseSetup; fdi: number; commit(next: CaseSetup, title: string): boolean }) {
  const type = cavityTypeOf(setup, fdi);
  const button = (to: CavityType, title: string) => (
    <button type="button" className="btn" aria-pressed={type === to} title={title} onClick={() => type !== to && commit(setCavity(setup, fdi, to), `${fdi} was not made an ${to}`)}>
      {to === 'inlay' ? 'Inlay' : 'Onlay'}
    </button>
  );
  return (
    <>
      {button('inlay', 'In a cavity prep: occlusal isthmus and proximal boxes')}
      {button('onlay', 'In a cavity prep that takes in one or more cusps')}
    </>
  );
}

// ---- Outer source -----------------------------------------------------------------------------------

/**
 * Where the outer surface comes from: the pre-op scan (the tooth as it was; exact, nothing to move) or the library
 * tooth fitted to the natural surface around the cavity (move, rotate and scale adjust it). Switching re-proposes.
 */
export function OuterSourceSwitch() {
  const fdi = useDesignStore((s) => s.activeFdi);
  const type = useCavityType();
  const source = useDesignStore((s) => outerSourceOf(s.doc, s.activeFdi));
  const hasPreop = useDesignStore((s) => s.doc.scans.some((x) => x.role === 'preop'));
  const computing = useToolStore((s) => s.crown?.computing ?? false);
  if (!type) return null;
  const set = (to: OuterSource) => {
    if (to === source) return;
    if (userEdit({ type: 'setOuterSource', fdi, source: to })) void crownTool.propose();
  };
  return (
    <div className="field">
      <span className="muted">Outer surface</span>
      <div className="seg" role="group" aria-label={`Outer surface of ${fdi}`}>
        <button
          type="button"
          className="btn"
          aria-pressed={source === 'preop'}
          disabled={!hasPreop || computing}
          title={hasPreop ? 'The tooth as it was before the preparation' : 'Import a pre-op scan in Scans first'}
          onClick={() => set('preop')}
        >
          Pre-op scan
        </button>
        <button type="button" className="btn" aria-pressed={source === 'library'} disabled={computing} title="The library tooth, fitted to the tooth around the cavity" onClick={() => set('library')}>
          Library tooth
        </button>
      </div>
      {!hasPreop && <span className="muted small">No pre-op scan in the case: the library tooth is used.</span>}
    </div>
  );
}

/** The Proposal step's explanation for an inlay or onlay. */
export function inlayProposalText(type: CavityType, source: OuterSource): string {
  const outer = source === 'preop' ? 'its top is the tooth as it was before the prep' : 'its top is the library tooth, fitted to the tooth around it';
  return `The ${type} fills the cavity up to its margin; ${outer}.`;
}

/** No nudges on a pre-op inlay: it follows the pre-op scan. */
export const useFollowsPreop = (): boolean => useDesignStore((s) => followsPreop(s.doc, s.activeFdi));

// ---- Adapt ------------------------------------------------------------------------------------------

const mm = (v: number, digits = 2) => (Number.isFinite(v) ? `${(Math.abs(v) < 0.5 * 10 ** -digits ? 0 : v).toFixed(digits)} mm` : '–');

/** The active inlay's report: margin fit, isthmus thickness, outer source and library fit, fitting surface. */
export function InlayReportView({ fdi, report }: { fdi: number; report: InlayReport }) {
  const r = report;
  const name = r.type === 'onlay' ? 'Onlay' : 'Inlay';
  const undercut = r.blockout.outlineUndercutPoints > 0;
  return (
    <section className="bridge-panel" aria-labelledby="inlay-head">
      <h3 id="inlay-head">
        {name} {fdi}
      </h3>
      <dl className="params">
        <dt>Outer surface</dt>
        <dd>{r.source === 'preop' ? 'pre-op scan' : `library tooth ${r.library?.templateId ?? ''}`}</dd>
        <dt>Margin fit</dt>
        <dd className={r.marginFit.ok ? 'ok' : 'bad'}>
          {mm(r.marginFit.maxMm, 3)} max <span className="muted">/ mean {mm(r.marginFit.meanMm, 3)}, limit {mm(r.marginFit.limitMm)}</span>
        </dd>
        <dt>Isthmus</dt>
        <dd className={r.isthmus.ok ? 'ok' : 'bad'}>
          {mm(r.isthmus.minMm)} <span className="muted">/ min {mm(r.isthmus.thresholdMm, 1)}</span>
        </dd>
        {r.library && (
          <>
            <dt>Library fit</dt>
            <dd className={r.library.ok ? 'ok' : 'bad'}>
              {mm(r.library.residual.p95Mm, 3)} <span className="muted">95th percentile / limit {mm(r.library.limitMm)}</span>
            </dd>
          </>
        )}
        <dt>Fitting gap</dt>
        <dd>
          {(r.fit.meanErrorMm * 1000).toFixed(1)} µm mean error <span className="muted">/ {(r.fit.maxErrorMm * 1000).toFixed(1)} µm max</span>
        </dd>
      </dl>
      {!r.marginFit.ok && <div className="warning">The {r.type} does not meet the cavity margin within {mm(r.marginFit.limitMm)}: redraw the margin on the cavosurface edge.</div>}
      {!r.isthmus.ok && <div className="warning">Too thin over the cavity floor: deepen the cavity or lower the thickness minimum.</div>}
      {r.library && !r.library.ok && <div className="warning">The library tooth does not fit the tooth around the cavity: move it, or use a pre-op scan.</div>}
      {undercut && <div className="warning">{r.blockout.outlineUndercutPoints} margin points are in an undercut along the insertion axis: change the axis.</div>}
    </section>
  );
}

/**
 * Adapt step for an inlay or onlay: the outer surface comes from its source, so there is no occlusion or contact
 * adaptation to run; the report and (in a bridge) the connectors.
 */
export function InlayAdapt() {
  const fdi = useDesignStore((s) => s.activeFdi);
  const report = useToolStore((s) => s.crown?.inlay);
  const type = useCavityType();
  const bridge = useActiveBridge();
  return (
    <div className="step-body">
      <p className="muted">The outer surface comes from its source and meets the tooth at the cavity margin. The occlusion map shows the space to the antagonist.</p>
      {bridge && <BridgeResultPanel />}
      <OuterSourceSwitch />
      {report ? <InlayReportView fdi={fdi} report={report} /> : <div className="muted">Computing the {type ?? 'inlay'}…</div>}
      <CrownStatusView />
      {bridge && <BridgeConnectors />}
      <fieldset className="view-controls">
        <legend>View</legend>
        <MapSelect />
        <FocusControls />
      </fieldset>
    </div>
  );
}

// ---- Finalize ---------------------------------------------------------------------------------------

const ADAPT_ROWS = ['occlusion', 'mesial', 'distal'];

/**
 * A unit's ready-to-mill rows, for an inlay or onlay: no adaptation rows (its outer surface is its source's), plus
 * the inlay gate: margin fit, isthmus, margin undercut and (library source) the library fit. Other teeth unchanged.
 * `prefix` is the item id prefix the caller uses ("35-" in a bridge).
 */
export function withInlayRows(setup: Pick<CaseSetup, 'teeth'>, fdi: number, items: ReadinessItem[], report: InlayReport | undefined, prefix = ''): ReadinessItem[] {
  if (!isCavity(setup, fdi)) return items;
  const kept = items.filter((i) => !ADAPT_ROWS.some((k) => i.id === `${prefix}${k}`));
  if (!report) return kept;
  const id = (k: string) => `${prefix}inlay-${k}`;
  const rows: ReadinessItem[] = [
    {
      id: id('margin-fit'),
      label: 'Meets the cavity margin',
      status: report.marginFit.ok ? 'pass' : 'fail',
      detail: `Within ${mm(report.marginFit.maxMm, 3)} (limit ${mm(report.marginFit.limitMm)})`,
    },
    {
      id: id('isthmus'),
      label: 'Thick over the cavity floor',
      status: report.isthmus.ok ? 'pass' : 'fail',
      detail: `Isthmus ${mm(report.isthmus.minMm)}, minimum ${mm(report.isthmus.thresholdMm, 1)}`,
    },
    {
      id: id('seat'),
      label: 'Seats along the axis',
      status: report.blockout.outlineUndercutPoints === 0 ? 'pass' : 'fail',
      detail: report.blockout.outlineUndercutPoints === 0 ? 'No margin point in an undercut' : `${report.blockout.outlineUndercutPoints} margin points in an undercut`,
    },
  ];
  if (report.library) {
    rows.push({
      id: id('library-fit'),
      label: 'Library tooth fits the tooth',
      status: report.library.ok ? 'pass' : 'fail',
      detail: `${mm(report.library.residual.p95Mm, 3)} (95th percentile, limit ${mm(report.library.limitMm)})`,
    });
  }
  return [...kept, ...rows];
}

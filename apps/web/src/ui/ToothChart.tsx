import { type BridgeIssueCode, bridgesOf, type CaseSetup, chartAdjacent, pairKey, RESTORATION_ROLE, unitKind } from '@dcad/shared';
import { useId, type CSSProperties } from 'react';
import './bridge.css';

/**
 * The dentist's view: each jaw in one row as if facing the patient, the patient's right on the left. Upper 18…11 |
 * 21…28 over lower 48…41 | 31…38, so every pair of chart neighbours sits side by side, 11–21 and 41–31 across the
 * midline. Sixteen teeth need the wider Case setup panel to keep their targets at 24 px.
 */
const quadrant = (q: number) => Array.from({ length: 8 }, (_, i) => q * 10 + i + 1);
const JAWS = [
  { label: 'Upper jaw', name: 'Upper', teeth: [...quadrant(1).reverse(), ...quadrant(2)], connectorsAbove: true },
  { label: 'Lower jaw', name: 'Lower', teeth: [...quadrant(4).reverse(), ...quadrant(3)], connectorsAbove: false },
] as const;

/** Grid column of the k-th tooth of a row (two half-columns each; column 17 is the midline gap). */
const toothColumn = (k: number) => 2 * k + 1 + (k >= 8 ? 1 : 0);

export type ConnectorState =
  | { status: 'connected' | 'open' }
  | { status: 'unavailable'; code: Extract<BridgeIssueCode, 'mixed-materials' | 'connector-not-permitted'>; reason: string };

/** The connector between two chart neighbours, or null when one of them is not in the case. */
export function connectorState(setup: Pick<CaseSetup, 'teeth' | 'connections'>, a: number, b: number): ConnectorState | null {
  const [oa, ob] = [setup.teeth.find((t) => t.fdi === a), setup.teeth.find((t) => t.fdi === b)];
  if (!oa || !ob || !chartAdjacent(a, b)) return null;
  if (setup.connections.some((p) => pairKey(p) === pairKey([a, b]))) return { status: 'connected' };
  // As in exocad: no connector between different materials, or for a type that permits none.
  if (oa.material !== ob.material) return { status: 'unavailable', code: 'mixed-materials', reason: `${a} and ${b} have different materials` };
  const permits = (o: typeof oa, other: typeof oa) => {
    const role = RESTORATION_ROLE[o.restoration];
    return role.connectors && (!role.connectsTo || role.connectsTo.includes(other.restoration));
  };
  if (!permits(oa, ob) || !permits(ob, oa)) {
    return { status: 'unavailable', code: 'connector-not-permitted', reason: `${oa.restoration} and ${ob.restoration} cannot be connected` };
  }
  return { status: 'open' };
}

interface ToothChartProps {
  setup: Pick<CaseSetup, 'teeth' | 'connections'>;
  active?: number;
  onToggleTooth(fdi: number): void;
  onToggleConnector(a: number, b: number): void;
  /** A connector that cannot be made: called with the reason instead of toggling. */
  onUnavailable(reason: string, code: BridgeIssueCode): void;
}

const at = (row: number, column: number, span = 2): CSSProperties => ({ gridRow: row, gridColumn: `${column} / span ${span}` });

/**
 * FDI tooth chart for the case setup: a tooth toggles in and out of the case; between two neighbours in the case, a
 * connector toggles their connection (bridges show as linked runs).
 */
export function ToothChart({ setup, active, onToggleTooth, onToggleConnector, onUnavailable }: ToothChartProps) {
  const id = useId();
  const bridges = bridgesOf(setup);
  const inCase = new Set(setup.teeth.map((t) => t.fdi));

  const tooth = (fdi: number, row: number, column: number) => {
    const selected = inCase.has(fdi);
    const kind = selected ? unitKind(setup, fdi) : undefined;
    const bridge = bridges.find((b) => b.includes(fdi));
    const description = kind && `${kind === 'pontic' ? 'pontic' : 'crown'}${bridge ? `, bridge ${bridge[0]}–${bridge.at(-1)}` : ''}`;
    return [
      <button
        key={fdi}
        type="button"
        className={`fdi-tooth${kind ? ` ${kind}` : ''}${fdi === active ? ' active' : ''}`}
        style={at(row, column)}
        aria-label={`Tooth ${fdi}`}
        aria-pressed={selected}
        aria-describedby={description ? `${id}-${fdi}` : undefined}
        title={description ? `${fdi}: ${description}` : `Add ${fdi}`}
        onClick={() => onToggleTooth(fdi)}
      >
        {fdi}
      </button>,
      description && (
        <span key={`${fdi}-d`} id={`${id}-${fdi}`} hidden>
          {description}
        </span>
      ),
    ];
  };

  const connector = (a: number, b: number, style: CSSProperties, direction: 'down' | 'up') => {
    const state = connectorState(setup, a, b);
    if (!state) return null;
    const label = `Connector ${a}–${b}`;
    const unavailable = state.status === 'unavailable';
    return (
      <button
        key={`${a}-${b}`}
        type="button"
        className={`fdi-link ${direction} ${state.status}`}
        style={style}
        aria-label={label}
        aria-pressed={state.status === 'connected'}
        aria-disabled={unavailable || undefined}
        aria-describedby={unavailable ? `${id}-${a}-${b}` : undefined}
        title={unavailable ? `${label}: unavailable, ${state.reason}` : `${label}: ${state.status === 'connected' ? 'connected' : 'not connected'}`}
        onClick={() => (unavailable ? onUnavailable(`${label}: ${state.reason}.`, state.code) : onToggleConnector(a, b))}
      >
        <span className="fdi-link-bar" aria-hidden />
        <span className="fdi-link-dot" aria-hidden />
        {unavailable && (
          <span id={`${id}-${a}-${b}`} hidden>
            Unavailable: {state.reason}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="fdi-chart">
      {JAWS.map(({ label, name, teeth, connectorsAbove }) => {
        // Rows: the upper jaw's connectors above its teeth, the lower jaw's below. DOM order = arch order.
        const [labels, links, row] = connectorsAbove ? [1, 2, 3] : [3, 2, 1];
        return (
          <div key={label} className="fdi-jaw" role="group" aria-label={label}>
            <div className="fdi-grid">
              {connectorsAbove && (
                <span className="fdi-side" style={at(labels, 1, 8)} aria-hidden>
                  Right
                </span>
              )}
              <span className="fdi-jaw-label" style={at(labels, 13, 9)} aria-hidden>
                {name}
              </span>
              {connectorsAbove && (
                <span className="fdi-side end" style={at(labels, 26, 8)} aria-hidden>
                  Left
                </span>
              )}
              {teeth.map((fdi, k) => [
                tooth(fdi, row, toothColumn(k)),
                k < 15 && connector(fdi, teeth[k + 1]!, at(links, toothColumn(k) + 1, k === 7 ? 3 : 2), connectorsAbove ? 'down' : 'up'),
              ])}
            </div>
          </div>
        );
      })}
      <ul className="fdi-legend" aria-hidden>
        <li>
          <span className="swatch crown" />
          Crown
        </li>
        <li>
          <span className="swatch pontic" />
          Pontic
        </li>
        <li>
          <span className="swatch link connected" />
          Connected
        </li>
        <li>
          <span className="swatch link open" />
          Not connected
        </li>
      </ul>
    </div>
  );
}

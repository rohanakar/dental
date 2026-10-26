import { archOrder, type CaseSetup, chartAdjacent, type Fdi, unitKind } from '@dcad/shared';
import { connectorState } from './ToothChart';

/**
 * Chart neighbours in the case that could be connected but are not. As in exocad, a connector is created by itself
 * only next to a pontic, so two neighbouring crowns stay separate restorations until the dot between them is on.
 */
export function separatePairs(setup: Pick<CaseSetup, 'teeth' | 'connections'>): Array<[Fdi, Fdi]> {
  const teeth = archOrder(setup.teeth.map((t) => t.fdi));
  const pairs: Array<[Fdi, Fdi]> = [];
  for (let i = 0; i + 1 < teeth.length; i++) {
    const [a, b] = [teeth[i]!, teeth[i + 1]!];
    if (chartAdjacent(a, b) && connectorState(setup, a, b)?.status === 'open') pairs.push([a, b]);
  }
  return pairs;
}

/** One line under the tooth chart: which neighbours stay separate, and how to join them. */
export function SeparateHint({ setup }: { setup: Pick<CaseSetup, 'teeth' | 'connections'> }) {
  const pairs = separatePairs(setup);
  if (pairs.length === 0) return null;
  const crowns = pairs.flat().every((fdi) => unitKind(setup, fdi) === 'abutment');
  const names = pairs.map(([a, b]) => `${a} and ${b}`).join(', ');
  return (
    <p className="muted small" role="note">
      {names} stay separate {crowns ? 'crowns' : 'restorations'} unless you switch on the dot between them.
    </p>
  );
}

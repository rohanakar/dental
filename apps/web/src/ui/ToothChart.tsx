const UPPER = [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28];
const LOWER = [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38];

interface ToothChartProps {
  selected: readonly number[];
  active?: number;
  onToggle(fdi: number): void;
}

/** FDI chart in the dentist's view (patient's right on the left). Every tooth can be selected. */
export function ToothChart({ selected, active, onToggle }: ToothChartProps) {
  const row = (teeth: number[], jaw: string) => (
    <div className="tooth-row" role="group" aria-label={`${jaw} teeth`}>
      {teeth.map((fdi, i) => {
        const isSelected = selected.includes(fdi);
        return (
          <button
            key={fdi}
            type="button"
            className={`tooth${isSelected ? ' selected' : ''}${fdi === active ? ' active' : ''}${i === 8 ? ' midline' : ''}`}
            aria-pressed={isSelected}
            title={`Tooth ${fdi}`}
            onClick={() => onToggle(fdi)}
          >
            {fdi}
          </button>
        );
      })}
    </div>
  );
  return (
    <div className="tooth-chart">
      {row(UPPER, 'Upper')}
      {row(LOWER, 'Lower')}
      <div className="tooth-chart-legend muted">
        <span>Patient right</span>
        <span>Patient left</span>
      </div>
    </div>
  );
}

import { jawOf, type ScanRole } from '@dcad/shared';
import { useDesignStore } from '../../design/store';
import { CheckIcon } from '../icons';
import { ObjectList } from '../ObjectList';
import { ScanImport } from '../ScanImport';

const JAW: Record<'upper' | 'lower', string> = { upper: 'Upper', lower: 'Lower' };

/** What the case needs, as a checklist: the prep's jaw, and the opposing jaw for the bite. */
export function ScansStep() {
  const fdi = useDesignStore((s) => s.activeFdi);
  const scans = useDesignStore((s) => s.doc.scans);
  const jaw = jawOf(fdi);
  const opposing = jaw === 'lower' ? 'upper' : 'lower';
  const has = (role: ScanRole) => scans.some((s) => s.role === role);
  const item = (role: 'upper' | 'lower', what: string) => (
    <li className={has(role) ? 'done' : ''}>
      {has(role) ? <CheckIcon /> : <span className="scan-ring" aria-hidden />}
      <span>
        {JAW[role]} jaw, {what}
        <span className="visually-hidden">: {has(role) ? 'loaded' : 'missing'}</span>
      </span>
    </li>
  );
  return (
    <div className="step-body">
      <ul className="scan-checklist" aria-label="Scans this case needs">
        {item(jaw, `with the prep of ${fdi}`)}
        {item(opposing, 'the opposing teeth')}
      </ul>
      <ScanImport />
      <ObjectList />
    </div>
  );
}

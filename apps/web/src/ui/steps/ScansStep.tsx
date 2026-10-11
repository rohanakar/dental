import { jawOf } from '@dcad/shared';
import { useDesignStore } from '../../design/store';
import { ObjectList } from '../ObjectList';
import { ScanImport } from '../ScanImport';

export function ScansStep() {
  const fdi = useDesignStore((s) => s.activeFdi);
  const scans = useDesignStore((s) => s.doc.scans);
  const jaw = jawOf(fdi);
  const hasJaw = scans.some((s) => s.role === jaw);
  return (
    <div className="step-body">
      <p className="muted">
        Tooth {fdi} is in the {jaw} jaw. Import the {jaw} scan (with the prep) and the opposing jaw, already in
        occlusion.
      </p>
      {!hasJaw && <div className="warning">The {jaw} scan is missing.</div>}
      <ScanImport />
      <ObjectList />
    </div>
  );
}

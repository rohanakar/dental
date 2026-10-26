import { jawOf, type ScanRole } from '@dcad/shared';
import { useRef, useState } from 'react';
import { useDesignStore } from '../design/store';
import { sceneController } from '../state/sceneController';
import { ACCEPTED_EXTENSIONS, assignRoles, isScanFile } from './files';

export function importFiles(files: File[], preferred: ScanRole): void {
  for (const { file, role } of assignRoles(files.filter(isScanFile), preferred)) {
    void sceneController.importFile(file, role);
  }
}

export function ScanImport() {
  // The prep's jaw is the scan every case needs, so files without a jaw in their name default to it.
  const [role, setRole] = useState<ScanRole>(() => jawOf(useDesignStore.getState().activeFdi));
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  return (
    <section>
      <h3>Import</h3>
      <div className="field">
        <label htmlFor="role">Import as</label>
        <select id="role" value={role} onChange={(e) => setRole(e.target.value as ScanRole)}>
          <option value="lower">Lower jaw</option>
          <option value="upper">Upper jaw</option>
          <option value="preop">Pre-op scan (before the prep)</option>
        </select>
      </div>
      <div
        className={`dropzone${over ? ' over' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          importFiles([...e.dataTransfer.files], role);
        }}
      >
        Drop STL / PLY files or click to browse
        <div className="muted">Names with "upper" or "lower" are sorted automatically</div>
      </div>
      <input
        ref={input}
        type="file"
        accept={ACCEPTED_EXTENSIONS.join(',')}
        multiple
        hidden
        onChange={(e) => {
          importFiles([...(e.target.files ?? [])], role);
          e.target.value = '';
        }}
      />
    </section>
  );
}

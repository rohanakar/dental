import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { CloseIcon } from './icons';
import './HelpSheet.css';

/** Whether the help sheet is open (the `?` key or Help in the toolbar). */
export const useHelp = create<{ open: boolean }>(() => ({ open: false }));
export const toggleHelp = (open = !useHelp.getState().open) => useHelp.setState({ open });

const SHORTCUTS: Array<[keys: string, what: string]> = [
  ['Drag', 'Rotate'],
  ['Right-drag', 'Pan'],
  ['Scroll', 'Zoom toward the pointer'],
  ['1 – 5', 'Occlusal, buccal, lingual, mesial, distal view'],
  ['F', 'Fit the scans in view'],
  ['O', 'Orthographic or perspective camera'],
  ['Ctrl/⌘ + Z', 'Undo'],
  ['Shift + Ctrl/⌘ + Z', 'Redo'],
  ['Backspace, Enter, Esc', 'Margin: remove the last point, close, cancel'],
  ['Arrows, Page Up/Down', 'Crown: move 0.1 mm (Shift: 0.5 mm)'],
  ['?', 'This sheet'],
];

const TERMS: Array<[term: string, meaning: string]> = [
  ['Prep', 'The tooth as the dentist shaped it to take the crown.'],
  ['Margin', 'The line on the prep where the crown ends.'],
  ['Tooth frame', "The tooth's directions (biting, toward the midline, toward the cheek), set by one click on the prep."],
  ['Mesial · distal', 'Toward the midline of the arch · away from it.'],
  ['Buccal · lingual', 'Toward the cheek or lip · toward the tongue or palate.'],
  ['Insertion axis', 'The direction the crown goes on.'],
  ['Undercut', 'Prep surface hidden from the insertion axis; the crown is blocked out there.'],
  ['Antagonist', 'The opposing tooth it bites against.'],
  ['Cement gap', 'The space for cement between the prep and the crown.'],
  ['Pontic', 'The replacement tooth of a bridge, resting on the gum.'],
  ['Connector', 'The joint between two units of a bridge.'],
  ['Draft', 'What auto-design proposed. Nothing is kept until you accept it.'],
  ['Colour maps', 'Clearance or thickness painted on the crown; the legend gives the scale.'],
];

/** Shortcuts and a short glossary, over the viewport. Not modal: the scene stays usable while it is open. */
export function HelpSheet() {
  const open = useHelp((s) => s.open);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) close.current?.focus();
  }, [open]);
  if (!open) return null;
  const dismiss = () => {
    toggleHelp(false);
    document.getElementById('help-button')?.focus();
  };
  return (
    <section className="help-sheet" role="dialog" aria-modal="false" aria-labelledby="help-title" onKeyDown={(e) => e.key === 'Escape' && dismiss()}>
      <header>
        <h2 id="help-title">Help</h2>
        <button ref={close} type="button" className="btn ghost icon" aria-label="Close help" onClick={dismiss}>
          <CloseIcon />
        </button>
      </header>
      <h3>Shortcuts</h3>
      <dl className="help-keys">
        {SHORTCUTS.map(([keys, what]) => (
          <div key={keys}>
            <dt>{keys}</dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
      <h3>Terms</h3>
      <dl className="help-terms">
        {TERMS.map(([term, meaning]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{meaning}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

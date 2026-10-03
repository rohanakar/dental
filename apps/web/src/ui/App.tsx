import { useEffect } from 'react';
import { sceneController } from '../state/sceneController';
import { useSceneStore } from '../state/sceneStore';
import { ObjectList } from './ObjectList';
import { ScanImport } from './ScanImport';
import { Toolbar, VIEWS } from './Toolbar';
import { Viewport } from './Viewport';

function useKeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const view = VIEWS.find((v) => v.key === e.key);
      if (view) sceneController.setView(view.view);
      else if (e.key === 'f' || e.key === 'F') sceneController.fit();
      else if (e.key === 'o' || e.key === 'O') {
        const p = useSceneStore.getState().projection;
        sceneController.setProjection(p === 'perspective' ? 'orthographic' : 'perspective');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function App() {
  useKeyboardShortcuts();
  return (
    <div className="app">
      <Toolbar />
      <aside className="panel">
        <ScanImport />
        <ObjectList />
      </aside>
      <Viewport />
    </div>
  );
}

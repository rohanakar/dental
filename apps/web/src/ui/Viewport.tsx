import { useEffect, useRef, useState } from 'react';
import { Viewer } from '../engine/Viewer';
import { sceneController } from '../state/sceneController';
import { useSceneStore } from '../state/sceneStore';
import { exposeForDebug } from '../debug';
import { designTools } from '../tools/controller';
import { ColorLegend } from './ColorLegend';
import { importFiles } from './ScanImport';

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function Viewport() {
  const host = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  const isEmpty = useSceneStore((s) => s.objects.length === 0);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const viewer = new Viewer(el, { background: cssVar('--viewport-bg', '#20242a') });
    sceneController.attachViewer(viewer);
    designTools.attachViewer(viewer);
    exposeForDebug('viewer', viewer);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onTheme = () => viewer.setBackground(cssVar('--viewport-bg', '#20242a'));
    media.addEventListener('change', onTheme);
    return () => {
      media.removeEventListener('change', onTheme);
      designTools.detachViewer(viewer);
      sceneController.detachViewer(viewer);
      viewer.dispose();
    };
  }, []);

  return (
    <main
      className={`viewport${over ? ' over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        importFiles([...e.dataTransfer.files], 'lower');
      }}
    >
      <div ref={host} className="canvas-host" />
      {isEmpty && (
        <div className="empty">
          <div>Drop upper and lower jaw scans (STL or PLY) here</div>
          <button className="btn primary" onClick={() => void sceneController.loadDemo()}>
            Load demo scans
          </button>
        </div>
      )}
      <ColorLegend />
      <div className="hint">Left-drag rotate · right-drag pan · wheel zoom to cursor · 1–5 views · F fit · O ortho</div>
    </main>
  );
}

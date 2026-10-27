import { useEffect, useRef, useState } from 'react';
import { Viewer } from '../engine/Viewer';
import { sceneController } from '../state/sceneController';
import { useSceneStore } from '../state/sceneStore';
import { useDesignStore } from '../design/store';
import { exposeForDebug } from '../debug';
import { designTools } from '../tools/controller';
import { ColorLegend } from './ColorLegend';
import { HelpSheet } from './HelpSheet';
import { importFiles } from './ScanImport';
import { useTheme } from './theme';

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function Viewport() {
  const host = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  const isEmpty = useSceneStore((s) => s.objects.length === 0);
  // Loading scans is the action of Scans only: elsewhere the step's own primary leads (Next on Case setup, "Go to Scans").
  const onScans = useDesignStore((s) => s.activeStep === 'scans');
  const viewerRef = useRef<Viewer | null>(null);
  const theme = useTheme((s) => s.theme);

  // The scene's ground follows the theme, read after <html> has the new data-theme (EditorTheme's effect).
  useEffect(() => {
    const id = requestAnimationFrame(() => viewerRef.current?.setBackground(cssVar('--viewport-bg', '#e9ecf0')));
    return () => cancelAnimationFrame(id);
  }, [theme]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const viewer = new Viewer(el, { background: cssVar('--viewport-bg', '#e9ecf0') });
    sceneController.attachViewer(viewer);
    designTools.attachViewer(viewer);
    exposeForDebug('viewer', viewer);
    viewerRef.current = viewer;
    return () => {
      viewerRef.current = null;
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
          <button className={`btn${onScans ? ' primary' : ''}`} onClick={() => void sceneController.loadDemo()}>
            Load demo scans
          </button>
        </div>
      )}
      <ColorLegend />
      <div className="hint">Drag to rotate · right-drag to pan · scroll to zoom · ? for help</div>
      <HelpSheet />
    </main>
  );
}

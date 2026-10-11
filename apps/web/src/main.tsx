import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { exposeForDebug } from './debug';
import { useDesignStore } from './design/store';
import { useSceneStore } from './state/sceneStore';
import { useToolStore } from './tools/toolStore';
import { App } from './ui/App';

exposeForDebug('design', useDesignStore);
exposeForDebug('scene', useSceneStore);
exposeForDebug('tools', useToolStore);

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

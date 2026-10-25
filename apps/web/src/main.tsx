import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { exposeForDebug } from './debug';
import { useDesignStore } from './design/store';
import { useSceneStore } from './state/sceneStore';
import { useToolStore } from './tools/toolStore';
import { bridgeTool, useBridgeStore } from './tools/bridgeTool';
import { crownTool } from './tools/crownTool';
import { analysis } from './workers/geometryClient';
import { useOrchestrator } from './ai/orchestrator';
import { useAssistant } from './ai/agent';
import { App } from './ui/App';

exposeForDebug('design', useDesignStore);
exposeForDebug('scene', useSceneStore);
exposeForDebug('tools', useToolStore);
exposeForDebug('orchestrator', useOrchestrator);
exposeForDebug('assistant', useAssistant);
exposeForDebug('crownTool', crownTool);
exposeForDebug('bridgeTool', bridgeTool);
exposeForDebug('bridge', useBridgeStore);
exposeForDebug('analysis', analysis);

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

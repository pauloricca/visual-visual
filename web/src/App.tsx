import { NodeEditor } from './editor/NodeEditor';
import { ViewerApp } from './viewer/ViewerApp';

export function App() {
  if (window.location.pathname === '/viewer') {
    return <ViewerApp />;
  }

  return <NodeEditor />;
}

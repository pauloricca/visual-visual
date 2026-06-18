import { useRef, type ChangeEvent } from 'react';
import type { ValidationResult } from '../graph/types';

export type ExportPanelView = 'glsl' | 'json';

interface Props {
  patchJson: string;
  shaderCode: string;
  validation: ValidationResult;
  compileErrors: string[];
  activeView: ExportPanelView;
  onActiveViewChange: (view: ExportPanelView) => void;
  onLoadJson: (json: string) => void;
  importError: string | null;
}

export function ExportPanel({
  patchJson,
  shaderCode,
  validation,
  compileErrors,
  activeView,
  onActiveViewChange,
  onLoadJson,
  importError,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const status = validation.ok && compileErrors.length === 0 && !importError ? 'ok' : 'error';

  function saveJson() {
    const blob = new Blob([patchJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'visual-visual-patch.json';
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function loadJson(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;

    try {
      onLoadJson(await file.text());
    } catch (error) {
      onLoadJson('');
      console.error(error);
    }
  }

  return (
    <aside className="export-panel">
      <div className="panel-header">
        <div className="panel-tabs" role="tablist" aria-label="Export panel view">
          <button
            className={`panel-tab ${activeView === 'glsl' ? 'panel-tab-active' : ''}`}
            type="button"
            role="tab"
            aria-selected={activeView === 'glsl'}
            onClick={() => onActiveViewChange('glsl')}
          >
            GLSL
          </button>
          <button
            className={`panel-tab ${activeView === 'json' ? 'panel-tab-active' : ''}`}
            type="button"
            role="tab"
            aria-selected={activeView === 'json'}
            onClick={() => onActiveViewChange('json')}
          >
            JSON
          </button>
        </div>
        <p className={`status status-${status}`}>{status}</p>
      </div>

      <div className="messages">
        {validation.errors.map((error) => <p className="message error" key={error}>{error}</p>)}
        {compileErrors.map((error) => <p className="message error" key={error}>{error}</p>)}
        {importError ? <p className="message error">{importError}</p> : null}
        {validation.warnings.map((warning) => <p className="message warning" key={warning}>{warning}</p>)}
      </div>

      {activeView === 'json' ? (
        <>
          <div className="panel-actions">
            <button className="panel-action" type="button" onClick={saveJson}>save JSON</button>
            <button className="panel-action" type="button" onClick={() => fileInputRef.current?.click()}>load JSON</button>
            <input
              ref={fileInputRef}
              className="panel-file-input"
              type="file"
              accept="application/json,.json"
              onChange={loadJson}
            />
          </div>
          <pre className="shader-preview">{patchJson}</pre>
        </>
      ) : (
        <pre className="shader-preview">{shaderCode || compileErrors.join('\n')}</pre>
      )}
    </aside>
  );
}

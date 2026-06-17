import { useEffect, useState } from 'react';
import type { Patch, ValidationResult } from '../graph/types';

interface Props {
  json: string;
  shaderCode: string;
  validation: ValidationResult;
  compileErrors: string[];
  onImport: (patch: Patch) => void;
}

export function ExportPanel({ json, shaderCode, validation, compileErrors, onImport }: Props) {
  const [draft, setDraft] = useState(json);
  const [tab, setTab] = useState<'json' | 'glsl'>('json');
  const status = validation.ok && compileErrors.length === 0 ? 'ok' : 'error';

  useEffect(() => setDraft(json), [json]);

  function importDraft() {
    const parsed = JSON.parse(draft) as Patch;
    onImport(parsed);
  }

  return (
    <aside className="export-panel">
      <div className="panel-header">
        <div>
          <h1>Visual Visual</h1>
          <p className={`status status-${status}`}>{status}</p>
        </div>
        <div className="tabs">
          <button className={tab === 'json' ? 'active' : ''} type="button" onClick={() => setTab('json')}>JSON</button>
          <button className={tab === 'glsl' ? 'active' : ''} type="button" onClick={() => setTab('glsl')}>GLSL</button>
        </div>
      </div>

      <div className="messages">
        {validation.errors.map((error) => <p className="message error" key={error}>{error}</p>)}
        {compileErrors.map((error) => <p className="message error" key={error}>{error}</p>)}
        {validation.warnings.map((warning) => <p className="message warning" key={warning}>{warning}</p>)}
      </div>

      {tab === 'json' ? (
        <>
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} />
          <div className="panel-actions">
            <button type="button" onClick={() => navigator.clipboard.writeText(json)}>copy</button>
            <button type="button" onClick={importDraft}>import</button>
          </div>
        </>
      ) : (
        <pre className="shader-preview">{shaderCode || compileErrors.join('\n')}</pre>
      )}
    </aside>
  );
}

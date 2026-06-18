import type { ValidationResult } from '../graph/types';

interface Props {
  shaderCode: string;
  validation: ValidationResult;
  compileErrors: string[];
}

export function ExportPanel({ shaderCode, validation, compileErrors }: Props) {
  const status = validation.ok && compileErrors.length === 0 ? 'ok' : 'error';

  return (
    <aside className="export-panel">
      <div className="panel-header">
        <p className={`status status-${status}`}>{status}</p>
      </div>

      <div className="messages">
        {validation.errors.map((error) => <p className="message error" key={error}>{error}</p>)}
        {compileErrors.map((error) => <p className="message error" key={error}>{error}</p>)}
        {validation.warnings.map((warning) => <p className="message warning" key={warning}>{warning}</p>)}
      </div>

      <pre className="shader-preview">{shaderCode || compileErrors.join('\n')}</pre>
    </aside>
  );
}

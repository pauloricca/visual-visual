import type { ValidationResult } from '../graph/types';

interface Props {
  shaderCode: string;
  validation: ValidationResult;
  compileErrors: string[];
  importError: string | null;
}

export function ExportPanel({
  shaderCode,
  validation,
  compileErrors,
  importError,
}: Props) {
  const status = validation.ok && compileErrors.length === 0 && !importError ? 'ok' : 'error';

  return (
    <aside className="export-panel">
      <div className="panel-header">
        <p className="status">GLSL</p>
        <p className={`status status-${status}`}>{status}</p>
      </div>

      <div className="messages">
        {validation.errors.map((error) => <p className="message error" key={error}>{error}</p>)}
        {compileErrors.map((error) => <p className="message error" key={error}>{error}</p>)}
        {importError ? <p className="message error">{importError}</p> : null}
        {validation.warnings.map((warning) => <p className="message warning" key={warning}>{warning}</p>)}
      </div>
      <pre className="shader-preview">{shaderCode || compileErrors.join('\n')}</pre>
    </aside>
  );
}

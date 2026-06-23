const GLSL_RESERVED_IDENTIFIERS = new Set([
  'attribute',
  'bool',
  'break',
  'bvec2',
  'bvec3',
  'bvec4',
  'case',
  'centroid',
  'const',
  'continue',
  'default',
  'discard',
  'do',
  'else',
  'false',
  'flat',
  'float',
  'for',
  'highp',
  'if',
  'in',
  'inout',
  'int',
  'invariant',
  'ivec2',
  'ivec3',
  'ivec4',
  'layout',
  'lowp',
  'mat2',
  'mat2x2',
  'mat2x3',
  'mat2x4',
  'mat3',
  'mat3x2',
  'mat3x3',
  'mat3x4',
  'mat4',
  'mat4x2',
  'mat4x3',
  'mat4x4',
  'mediump',
  'out',
  'precision',
  'return',
  'sampler2D',
  'smooth',
  'struct',
  'switch',
  'true',
  'uniform',
  'uint',
  'uvec2',
  'uvec3',
  'uvec4',
  'varying',
  'vec2',
  'vec3',
  'vec4',
  'void',
  'while',
  'u_camera',
  'u_frame',
  'u_mic_level',
  'u_resolution',
  'u_time',
  'uv',
]);

const IDENTIFIER_PATTERN = /[A-Za-z_][A-Za-z0-9_]*/g;

export function extractExpressionInputs(expression: string): string[] {
  const inputs: string[] = [];
  const seen = new Set<string>();
  const scanExpression = stripComments(expression);

  for (const match of scanExpression.matchAll(IDENTIFIER_PATTERN)) {
    const name = match[0];
    const index = match.index ?? 0;
    if (!isExpressionInputIdentifier(scanExpression, name, index)) continue;
    if (seen.has(name)) continue;

    seen.add(name);
    inputs.push(name);
  }

  return inputs;
}

export function replaceExpressionInputs(
  expression: string,
  replacementFor: (name: string) => string,
): string {
  return expression.replace(IDENTIFIER_PATTERN, (name, index: number) => {
    if (!isExpressionInputIdentifier(expression, name, index)) return name;
    return replacementFor(name);
  });
}

export function normalizeExpressionFloatLiterals(expression: string): string {
  return expression.replace(/\b\d+\b/g, (literal, index) => {
    const previous = expression[index - 1] ?? '';
    const next = expression[index + literal.length] ?? '';
    const beforePrevious = expression[index - 2] ?? '';
    if (previous === '.' || next === '.' || next === 'e' || next === 'E') return literal;
    if (previous === 'e' || previous === 'E') return literal;
    if ((previous === '-' || previous === '+') && (beforePrevious === 'e' || beforePrevious === 'E')) return literal;
    if (/[A-Za-z_]/.test(next)) return literal;
    return `${literal}.0`;
  });
}

function isExpressionInputIdentifier(expression: string, name: string, index: number): boolean {
  if (GLSL_RESERVED_IDENTIFIERS.has(name)) return false;
  if (name.startsWith('gl_')) return false;

  const previous = previousNonWhitespace(expression, index - 1);
  if (previous === '.') return false;

  const next = nextNonWhitespace(expression, index + name.length);
  if (next === '(') return false;

  return true;
}

function previousNonWhitespace(value: string, start: number): string | null {
  for (let index = start; index >= 0; index -= 1) {
    const character = value[index];
    if (character && !/\s/.test(character)) return character;
  }

  return null;
}

function nextNonWhitespace(value: string, start: number): string | null {
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (character && !/\s/.test(character)) return character;
  }

  return null;
}

function stripComments(value: string): string {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ');
}

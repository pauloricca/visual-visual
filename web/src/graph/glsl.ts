import { getDefinition } from './nodeTypes';
import type { Patch, PatchLink, PatchNode } from './types';
import { incomingLinksByInput, validatePatch } from './validate';

export interface CompileResult {
  ok: boolean;
  shaderCode: string;
  errors: string[];
  warnings: string[];
}

export type GlslTarget = 'desktop' | 'webgl2';

export function compilePatchToGlsl(patch: Patch, target: GlslTarget = 'desktop'): CompileResult {
  const validation = validatePatch(patch);
  if (!validation.ok) {
    return {
      ok: false,
      shaderCode: '',
      errors: validation.errors,
      warnings: validation.warnings,
    };
  }

  const nodes = new Map(patch.nodes.map((node) => [node.id, node]));
  const incoming = incomingLinksByInput(patch.links);
  const output = patch.nodes.find((node) => node.type === 'Output');
  if (!output) {
    return {
      ok: false,
      shaderCode: '',
      errors: ['Patch needs one Output node.'],
      warnings: validation.warnings,
    };
  }

  const context: CompileContext = {
    nodes,
    incoming,
    cache: new Map(),
    visiting: new Set(),
  };

  try {
    const r = resolveInput(output, 'r', context);
    const g = resolveInput(output, 'g', context);
    const b = resolveInput(output, 'b', context);
    return {
      ok: true,
      shaderCode: buildShader(r, g, b, target),
      errors: [],
      warnings: validation.warnings,
    };
  } catch (error) {
    return {
      ok: false,
      shaderCode: '',
      errors: [error instanceof Error ? error.message : String(error)],
      warnings: validation.warnings,
    };
  }
}

interface CompileContext {
  nodes: Map<string, PatchNode>;
  incoming: Map<string, PatchLink[]>;
  cache: Map<string, string>;
  visiting: Set<string>;
}

function resolveInput(node: PatchNode, port: string, context: CompileContext): string {
  const links = context.incoming.get(`${node.id}.${port}`) ?? [];
  if (links.length === 1) {
    const [link] = links;
    return resolveOutput(link.from.node, link.from.port, context);
  }
  if (links.length > 1) {
    const expressions = links.map((link) => resolveOutput(link.from.node, link.from.port, context));
    return `((${expressions.join(' + ')}) / ${formatFloat(expressions.length)})`;
  }

  const definition = getDefinition(node.type);
  const portDefinition = definition.inputs.find((input) => input.name === port);
  const value = node.params[port] ?? portDefinition?.defaultValue ?? 0;
  return formatFloat(value);
}

function resolveOutput(nodeId: string, port: string, context: CompileContext): string {
  const cacheKey = `${nodeId}.${port}`;
  const cached = context.cache.get(cacheKey);
  if (cached) return cached;
  if (context.visiting.has(cacheKey)) {
    throw new Error(`Cycle while compiling ${cacheKey}.`);
  }

  const node = context.nodes.get(nodeId);
  if (!node) {
    throw new Error(`Node "${nodeId}" does not exist.`);
  }

  context.visiting.add(cacheKey);
  const expression = emitOutput(node, port, context);
  context.visiting.delete(cacheKey);
  context.cache.set(cacheKey, expression);
  return expression;
}

function emitOutput(node: PatchNode, port: string, context: CompileContext): string {
  switch (node.type) {
    case 'System':
      return emitSystem(port);
    case 'Output':
      throw new Error('Output node has no output ports.');
    case 'Constant':
      assertPort(node, port, 'value');
      return resolveInput(node, 'value', context);
    case 'Add':
      return binary(node, context, '+');
    case 'Subtract':
      return binary(node, context, '-');
    case 'Multiply':
      return binary(node, context, '*');
    case 'Divide':
      return binary(node, context, '/');
    case 'Mod':
      return `mod(${input(node, 'a', context)}, ${input(node, 'b', context)})`;
    case 'Sin':
      return call1('sin', node, context);
    case 'Cos':
      return call1('cos', node, context);
    case 'Abs':
      return call1('abs', node, context);
    case 'Floor':
      return call1('floor', node, context);
    case 'Fract':
      return call1('fract', node, context);
    case 'Step':
      return `step(${input(node, 'edge', context)}, ${input(node, 'value', context)})`;
    case 'Smoothstep':
      return `smoothstep(${input(node, 'edge0', context)}, ${input(node, 'edge1', context)}, ${input(node, 'value', context)})`;
    case 'Mix':
      return `mix(${input(node, 'a', context)}, ${input(node, 'b', context)}, ${input(node, 'amount', context)})`;
    case 'Min':
      return `min(${input(node, 'a', context)}, ${input(node, 'b', context)})`;
    case 'Max':
      return `max(${input(node, 'a', context)}, ${input(node, 'b', context)})`;
    case 'Clamp':
      return `clamp(${input(node, 'value', context)}, ${input(node, 'min', context)}, ${input(node, 'max', context)})`;
    case 'Noise':
      return `hashNoise(vec2(${input(node, 'x', context)}, ${input(node, 'y', context)}) + ${input(node, 'seed', context)})`;
    default:
      throw new Error(`Unsupported node type "${node.type}".`);
  }
}

function input(node: PatchNode, port: string, context: CompileContext): string {
  return resolveInput(node, port, context);
}

function binary(node: PatchNode, context: CompileContext, operator: string): string {
  return `(${input(node, 'a', context)} ${operator} ${input(node, 'b', context)})`;
}

function call1(functionName: string, node: PatchNode, context: CompileContext): string {
  return `${functionName}(${input(node, 'value', context)})`;
}

function assertPort(node: PatchNode, actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(`${node.type}.${actual} is not supported.`);
  }
}

function emitSystem(port: string): string {
  switch (port) {
    case 'x':
      return 'x';
    case 'y':
      return 'y';
    case 'time':
      return 'u_time';
    case 'frame':
      return 'float(u_frame)';
    default:
      throw new Error(`System has no output port "${port}".`);
  }
}

function formatFloat(value: number): string {
  if (!Number.isFinite(value)) return '0.0';
  if (Object.is(value, -0)) return '0.0';
  const text = Number(value).toString();
  return text.includes('.') || text.includes('e') ? text : `${text}.0`;
}

function buildShader(r: string, g: string, b: string, target: GlslTarget): string {
  const header =
    target === 'webgl2'
      ? `#version 300 es
precision highp float;
precision highp int;
out vec4 fragColor;`
      : `#version 330 core
out vec4 fragColor;
`;

  return `${header}
uniform vec2 u_resolution;
uniform float u_time;
uniform int u_frame;

float hashNoise(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 uv = gl_FragCoord.xy / max(u_resolution, vec2(1.0));
  float x = uv.x;
  float y = uv.y;

  float r = ${r};
  float g = ${g};
  float b = ${b};

  fragColor = vec4(r, g, b, 1.0);
}
`;
}

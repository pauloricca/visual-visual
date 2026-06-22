import { getNodeDefinition } from './nodeTypes';
import { expandGroups } from './subpatch';
import type { Patch, PatchLink, PatchNode } from './types';
import { findFeedbackLinks, incomingLinksByInput, linkKey, validatePatch } from './validate';

export interface CompileResult {
  ok: boolean;
  shaderCode: string;
  shaderArgs: ShaderArg[];
  errors: string[];
  warnings: string[];
  feedbackLinkIds: string[];
  feedbackTextureCount: number;
  bufferSlots: ShaderBufferSlot[];
  delaySlots: ShaderDelaySlot[];
  envelopeSlots: ShaderEnvelopeSlot[];
  scopeSlots: ShaderScopeSlot[];
  meterSlots: ShaderMeterSlot[];
  media: ShaderMediaRequirements;
}

export interface ShaderArg {
  name: string;
  value: number;
  nodeId: string;
  port: string;
}

export interface ShaderDelaySlot {
  nodeId: string;
  samplerName: string;
  frameArgName: string;
}

export interface ShaderBufferSlot {
  nodeId: string;
  samplerName: string;
}

export interface ShaderEnvelopeSlot {
  nodeId: string;
  samplerName: string;
}

export interface ShaderScopeSlot {
  nodeId: string;
}

export interface ShaderMeterSlot {
  nodeId: string;
}

export interface ShaderMediaRequirements {
  useMic: boolean;
  useCamera: boolean;
}

export type GlslTarget = 'desktop' | 'webgl2';

interface CompileOptions {
  enableScopes?: boolean;
}

export function compilePatchToGlsl(
  patch: Patch,
  target: GlslTarget = 'desktop',
  options: CompileOptions = {},
): CompileResult {
  const expandedPatch = expandGroups(patch);
  const enableScopes = options.enableScopes ?? true;
  const validation = validatePatch(expandedPatch);
  if (!validation.ok) {
    return {
      ok: false,
      shaderCode: '',
      shaderArgs: [],
      errors: validation.errors,
      warnings: validation.warnings,
      feedbackLinkIds: [],
      feedbackTextureCount: 0,
      bufferSlots: [],
      delaySlots: [],
      envelopeSlots: [],
      scopeSlots: [],
      meterSlots: [],
      media: emptyMediaRequirements(),
    };
  }

  const nodes = new Map(expandedPatch.nodes.map((node) => [node.id, node]));
  const incoming = incomingLinksByInput(expandedPatch.links);
  const shaderArgs = collectShaderArgs(expandedPatch, incoming);
  const feedbackSlots = findFeedbackLinks(expandedPatch).map((link, index): FeedbackSlot => ({
    link,
    linkId: linkKey(link),
    textureIndex: Math.floor(index / 4),
    channelIndex: index % 4,
  }));
  const feedbackByLink = new Map(feedbackSlots.map((slot) => [slot.linkId, slot]));
  const feedbackTextureCount = Math.ceil(feedbackSlots.length / 4);
  let delaySlots: ShaderDelaySlot[] = [];
  try {
    delaySlots = collectDelaySlots(expandedPatch, shaderArgs);
  } catch (error) {
    return {
      ok: false,
      shaderCode: '',
      shaderArgs,
      errors: [error instanceof Error ? error.message : String(error)],
      warnings: validation.warnings,
      feedbackLinkIds: feedbackSlots.map((slot) => slot.linkId),
      feedbackTextureCount,
      bufferSlots: [],
      delaySlots: [],
      envelopeSlots: [],
      scopeSlots: [],
      meterSlots: [],
      media: emptyMediaRequirements(),
    };
  }
  const delayByNodeId = new Map(delaySlots.map((slot) => [slot.nodeId, slot]));
  const bufferSlots = collectBufferSlots(expandedPatch);
  const bufferByNodeId = new Map(bufferSlots.map((slot) => [slot.nodeId, slot]));
  const envelopeSlots = collectEnvelopeSlots(expandedPatch);
  const envelopeByNodeId = new Map(envelopeSlots.map((slot) => [slot.nodeId, slot]));
  const scopeSlots = enableScopes ? collectScopeSlots(expandedPatch) : [];
  const meterSlots = enableScopes ? collectMeterSlots(expandedPatch, incoming) : [];
  const output = expandedPatch.nodes.find((node) => node.type === 'Output');
  if (!output) {
    return {
      ok: false,
      shaderCode: '',
      shaderArgs: [],
      errors: ['Patch needs one Output node.'],
      warnings: validation.warnings,
      feedbackLinkIds: feedbackSlots.map((slot) => slot.linkId),
      feedbackTextureCount,
      bufferSlots,
      delaySlots,
      envelopeSlots,
      scopeSlots,
      meterSlots,
      media: emptyMediaRequirements(),
    };
  }

  const context: CompileContext = {
    nodes,
    incoming,
    feedbackByLink,
    cache: new Map(),
    visiting: new Set(),
    statements: [],
    usedVariables: new Set(['uv', 'x', 'y', 'r', 'g', 'b']),
    shaderArgs,
    shaderArgNames: new Map(shaderArgs.map((arg) => [`${arg.nodeId}.${arg.port}`, arg.name])),
    edgeWeightArgNames: new Map(shaderArgs
      .filter((arg) => arg.port === 'weight')
      .map((arg) => [arg.nodeId, arg.name])),
    delayByNodeId,
    bufferByNodeId,
    envelopeByNodeId,
    media: emptyMediaRequirements(),
  };

  try {
    const r = resolveInput(output, 'r', context);
    const g = resolveInput(output, 'g', context);
    const b = resolveInput(output, 'b', context);
    const feedbackExpressions = feedbackSlots.map((slot) =>
      applyLinkWeight(slot.link, resolveOutput(slot.link.from.node, slot.link.from.port, context), context),
    );
    const delayExpressions = delaySlots.map((slot) => {
      const node = nodes.get(slot.nodeId);
      if (!node) {
        throw new Error(`Delay node "${slot.nodeId}" does not exist.`);
      }
      return resolveInput(node, 'value', context);
    });
    const bufferExpressions = bufferSlots.map((slot) => {
      const node = nodes.get(slot.nodeId);
      if (!node) {
        throw new Error(`Buffer node "${slot.nodeId}" does not exist.`);
      }
      return `vec2(${resolveInput(node, 'inX', context)}, ${resolveInput(node, 'inY', context)})`;
    });
    const envelopeExpressions = envelopeSlots.map((slot) => resolveOutput(slot.nodeId, 'value', context));
    const scopeExpressions = scopeSlots.map((slot) => {
      const node = nodes.get(slot.nodeId);
      if (!node) {
        throw new Error(`Scope node "${slot.nodeId}" does not exist.`);
      }
      return resolveInput(node, 'value', context);
    });
    const meterExpressions = meterSlots.map((slot) => {
      const node = nodes.get(slot.nodeId);
      if (!node) {
        throw new Error(`Meter node "${slot.nodeId}" does not exist.`);
      }
      return resolveInput(node, 'value', context);
    });

    return {
      ok: true,
      shaderCode: buildShader(
        r,
        g,
        b,
        output.id,
        target,
        context.statements,
        feedbackExpressions,
        feedbackSlots,
        feedbackTextureCount,
        context.shaderArgs,
        delaySlots,
        delayExpressions,
        bufferSlots,
        bufferExpressions,
        envelopeSlots,
        envelopeExpressions,
        scopeSlots,
        scopeExpressions,
        meterSlots,
        meterExpressions,
        context.media,
      ),
      shaderArgs: context.shaderArgs,
      errors: [],
      warnings: validation.warnings,
      feedbackLinkIds: feedbackSlots.map((slot) => slot.linkId),
      feedbackTextureCount,
      bufferSlots,
      delaySlots,
      envelopeSlots,
      scopeSlots,
      meterSlots,
      media: context.media,
    };
  } catch (error) {
    return {
      ok: false,
      shaderCode: '',
      shaderArgs: context.shaderArgs,
      errors: [error instanceof Error ? error.message : String(error)],
      warnings: validation.warnings,
      feedbackLinkIds: feedbackSlots.map((slot) => slot.linkId),
      feedbackTextureCount,
      bufferSlots,
      delaySlots,
      envelopeSlots,
      scopeSlots,
      meterSlots,
      media: context.media,
    };
  }
}

interface CompileContext {
  nodes: Map<string, PatchNode>;
  incoming: Map<string, PatchLink[]>;
  feedbackByLink: Map<string, FeedbackSlot>;
  cache: Map<string, string>;
  visiting: Set<string>;
  statements: GlslStatement[];
  usedVariables: Set<string>;
  shaderArgs: ShaderArg[];
  shaderArgNames: Map<string, string>;
  edgeWeightArgNames: Map<string, string>;
  delayByNodeId: Map<string, ShaderDelaySlot>;
  bufferByNodeId: Map<string, ShaderBufferSlot>;
  envelopeByNodeId: Map<string, ShaderEnvelopeSlot>;
  media: ShaderMediaRequirements;
}

interface FeedbackSlot {
  link: PatchLink;
  linkId: string;
  textureIndex: number;
  channelIndex: number;
}

interface GlslStatement {
  nodeId: string;
  variable: string;
  expression: string;
}

function resolveInput(node: PatchNode, port: string, context: CompileContext): string {
  const links = context.incoming.get(`${node.id}.${port}`) ?? [];
  if (links.length > 0) {
    return combineInputLinks(node, port, links, context);
  }

  return defaultInputArg(node, port, context);
}

function combineInputLinks(node: PatchNode, port: string, links: PatchLink[], context: CompileContext): string {
  const setExpressions: string[] = [];
  const addExpressions: string[] = [];
  const multiplyExpressions: string[] = [];

  for (const link of links) {
    const expression = resolveLinkExpression(link, context);
    switch (link.mode ?? 'set') {
      case 'add':
        addExpressions.push(expression);
        break;
      case 'multiply':
        multiplyExpressions.push(expression);
        break;
      case 'set':
        setExpressions.push(expression);
        break;
    }
  }

  let expression = setExpressions.length > 0
    ? averageExpressions(setExpressions)
    : defaultInputArg(node, port, context);

  if (addExpressions.length > 0) {
    expression = `(${[expression, ...addExpressions].join(' + ')})`;
  }

  if (multiplyExpressions.length > 0) {
    expression = `(${[expression, ...multiplyExpressions].join(' * ')})`;
  }

  return expression;
}

function resolveLinkExpression(link: PatchLink, context: CompileContext): string {
  const feedbackSlot = context.feedbackByLink.get(linkKey(link));
  return feedbackSlot
    ? readFeedback(feedbackSlot)
    : applyLinkWeight(link, resolveOutput(link.from.node, link.from.port, context), context);
}

function averageExpressions(expressions: string[]): string {
  if (expressions.length === 1) return expressions[0];
  return `((${expressions.join(' + ')}) / ${formatFloat(expressions.length)})`;
}

function defaultInputArg(node: PatchNode, port: string, context: CompileContext): string {
  const arg = context.shaderArgNames.get(`${node.id}.${port}`);
  if (arg) {
    return arg;
  }

  throw new Error(`Missing shader arg for unlinked input "${node.id}.${port}".`);
}

function applyLinkWeight(link: PatchLink, expression: string, context: CompileContext): string {
  const weightArg = context.edgeWeightArgNames.get(linkKey(link));
  if (!weightArg) return expression;
  return `(${expression} * ${weightArg})`;
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

  const variable = makeVariableName(node.id, port, context.usedVariables);
  context.cache.set(cacheKey, variable);
  context.statements.push({
    nodeId: node.id,
    variable,
    expression,
  });

  return variable;
}

function emitOutput(node: PatchNode, port: string, context: CompileContext): string {
  switch (node.type) {
    case 'System':
      if (port === 'mic') {
        context.media.useMic = true;
      }
      return emitSystem(port);
    case 'Output':
      if (port !== 'r' && port !== 'g' && port !== 'b') {
        throw new Error(`Output.${port} is not supported.`);
      }
      return resolveInput(node, port, context);
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
    case 'Pow':
      return `pow(${input(node, 'a', context)}, ${input(node, 'b', context)})`;
    case 'Sin':
      return call1('sin', node, context);
    case 'Cos':
      return call1('cos', node, context);
    case 'Tan':
      return call1('tan', node, context);
    case 'Atan':
      return call1('atan', node, context);
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
    case 'Map':
      return emitMap(node, context);
    case 'Min':
      return `min(${input(node, 'a', context)}, ${input(node, 'b', context)})`;
    case 'Max':
      return `max(${input(node, 'a', context)}, ${input(node, 'b', context)})`;
    case 'Clamp':
      return `clamp(${input(node, 'value', context)}, ${input(node, 'min', context)}, ${input(node, 'max', context)})`;
    case 'Saw':
      assertPort(node, port, 'value');
      return `(${oscillatorPhase(node, context)} * 2.0 - 1.0)`;
    case 'Ramp':
      assertPort(node, port, 'value');
      return oscillatorPhase(node, context);
    case 'Pulse':
      assertPort(node, port, 'value');
      return `step(${oscillatorPhase(node, context)}, clamp(${input(node, 'width', context)}, 0.0, 1.0))`;
    case 'Triangle':
      assertPort(node, port, 'value');
      return `(1.0 - abs(${oscillatorPhase(node, context)} * 2.0 - 1.0))`;
    case 'Polar':
      return emitPolar(node, port, context);
    case 'toPolar':
      return emitToPolar(node, port, context);
    case 'HSV':
      return emitHsv(node, port, context);
    case 'Gate':
      assertPort(node, port, 'value');
      return emitGate(node, context);
    case 'Rotate':
      return emitRotate(node, port, context);
    case 'Quantise':
      assertPort(node, port, 'value');
      return `floor(${input(node, 'value', context)} * max(${input(node, 'levels', context)}, 1.0)) / max(${input(node, 'levels', context)}, 1.0)`;
    case 'Distance':
      assertPort(node, port, 'value');
      return `distance(vec2(${input(node, 'x1', context)}, ${input(node, 'y1', context)}), vec2(${input(node, 'x2', context)}, ${input(node, 'y2', context)}))`;
    case 'Noise':
      return `fbmNoise(vec2(${input(node, 'x', context)}, ${input(node, 'y', context)}) * max(${input(node, 'scale', context)}, 0.0001) + vec2(${input(node, 'seed', context)} * 17.0, ${input(node, 'seed', context)} * 31.0), ${input(node, 'octaves', context)})`;
    case 'Noise3':
      return `fbmNoise3(vec3(${input(node, 'x', context)}, ${input(node, 'y', context)}, ${input(node, 'z', context)}) * max(${input(node, 'scale', context)}, 0.0001) + vec3(${input(node, 'seed', context)} * 17.0, ${input(node, 'seed', context)} * 31.0, ${input(node, 'seed', context)} * 47.0), ${input(node, 'octaves', context)})`;
    case 'Noise3Fast':
      return `fbmNoise3Fast(vec3(${input(node, 'x', context)}, ${input(node, 'y', context)}, ${input(node, 'z', context)}) * max(${input(node, 'scale', context)}, 0.0001) + vec3(${input(node, 'seed', context)} * 17.0, ${input(node, 'seed', context)} * 31.0, ${input(node, 'seed', context)} * 47.0), ${input(node, 'octaves', context)})`;
    case 'Camera':
      return emitCamera(node, port, context);
    case 'Envelope':
      return emitEnvelope(node, port, context);
    case 'Buffer':
      return emitBuffer(node, port, context);
    case 'Delay': {
      assertPort(node, port, 'value');
      const slot = context.delayByNodeId.get(node.id);
      if (!slot) {
        throw new Error(`Delay node "${node.id}" is missing a hidden buffer.`);
      }
      return `texture(${slot.samplerName}, uv).r`;
    }
    case 'midiCC':
      assertPort(node, port, 'value');
      return input(node, 'value', context);
    default:
      throw new Error(`Unsupported node type "${node.type}".`);
  }
}

function oscillatorPhase(node: PatchNode, context: CompileContext): string {
  return `fract(u_time * ${input(node, 'frequency', context)} + ${input(node, 'phase', context)})`;
}

function emitMap(node: PatchNode, context: CompileContext): string {
  const value = input(node, 'value', context);
  const srcMin = input(node, 'srcMin', context);
  const srcMax = input(node, 'srcMax', context);
  const trgtMin = input(node, 'trgtMin', context);
  const trgtMax = input(node, 'trgtMax', context);
  const sourceRange = `(${srcMax} - ${srcMin})`;
  const denominator = `((abs(${sourceRange}) < 0.000001) ? 0.000001 : ${sourceRange})`;

  return `mix(${trgtMin}, ${trgtMax}, ((${value} - ${srcMin}) / ${denominator}))`;
}

function emitPolar(node: PatchNode, port: string, context: CompileContext): string {
  const radius = input(node, 'radius', context);
  const angle = input(node, 'angle', context);

  switch (port) {
    case 'x':
      return `(${radius} * cos(${angle}))`;
    case 'y':
      return `(${radius} * sin(${angle}))`;
    default:
      throw new Error(`Polar.${port} is not supported.`);
  }
}

function emitToPolar(node: PatchNode, port: string, context: CompileContext): string {
  const x = input(node, 'x', context);
  const y = input(node, 'y', context);

  switch (port) {
    case 'radius':
      return `length(vec2(${x}, ${y}))`;
    case 'angle':
      return `atan(${y}, ${x})`;
    default:
      throw new Error(`toPolar.${port} is not supported.`);
  }
}

function emitHsv(node: PatchNode, port: string, context: CompileContext): string {
  const channel = { r: 'r', g: 'g', b: 'b' }[port];
  if (!channel) {
    throw new Error(`HSV.${port} is not supported.`);
  }

  return `hsvToRgb(vec3(${input(node, 'h', context)}, ${input(node, 's', context)}, ${input(node, 'v', context)})).${channel}`;
}

function emitGate(node: PatchNode, context: CompileContext): string {
  const value = input(node, 'value', context);
  const gate = input(node, 'gate', context);
  const minValue = input(node, 'min', context);
  const maxValue = input(node, 'max', context);
  const lower = `min(${minValue}, ${maxValue})`;
  const upper = `max(${minValue}, ${maxValue})`;

  return `((${gate} >= ${lower} && ${gate} <= ${upper}) ? ${value} : 0.0)`;
}

function emitRotate(node: PatchNode, port: string, context: CompileContext): string {
  const x = input(node, 'x', context);
  const y = input(node, 'y', context);
  const angle = input(node, 'angle', context);

  switch (port) {
    case 'x':
      return `((${x} * cos(${angle})) - (${y} * sin(${angle})))`;
    case 'y':
      return `((${x} * sin(${angle})) + (${y} * cos(${angle})))`;
    default:
      throw new Error(`Rotate.${port} is not supported.`);
  }
}

function emitEnvelope(node: PatchNode, port: string, context: CompileContext): string {
  assertPort(node, port, 'value');
  const slot = context.envelopeByNodeId.get(node.id);
  if (!slot) {
    throw new Error(`Envelope node "${node.id}" is missing a hidden buffer.`);
  }

  const previous = `texture(${slot.samplerName}, uv).r`;
  const current = input(node, 'value', context);
  const attack = input(node, 'attack', context);
  const release = input(node, 'release', context);
  const frames = `((${current} > ${previous}) ? ${attack} : ${release})`;
  return `mix(${previous}, ${current}, clamp(1.0 / max(${frames}, 1.0), 0.0, 1.0))`;
}

function emitBuffer(node: PatchNode, port: string, context: CompileContext): string {
  const channel = { x: 'r', y: 'g' }[port];
  if (!channel) {
    throw new Error(`Buffer.${port} is not supported.`);
  }

  const slot = context.bufferByNodeId.get(node.id);
  if (!slot) {
    throw new Error(`Buffer node "${node.id}" is missing a hidden buffer.`);
  }

  return `texture(${slot.samplerName}, clamp(vec2(${input(node, 'outX', context)}, ${input(node, 'outY', context)}), vec2(0.0), vec2(1.0))).${channel}`;
}

function emitCamera(node: PatchNode, port: string, context: CompileContext): string {
  context.media.useCamera = true;
  const channel = { r: 'r', g: 'g', b: 'b' }[port];
  if (!channel) {
    throw new Error(`Camera.${port} is not supported.`);
  }

  return `texture(u_camera, clamp(vec2(${input(node, 'x', context)}, ${input(node, 'y', context)}), vec2(0.0), vec2(1.0))).${channel}`;
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
    case 'mic':
      return 'u_mic_level';
    default:
      throw new Error(`System has no output port "${port}".`);
  }
}

function readFeedback(slot: FeedbackSlot): string {
  const channel = ['x', 'y', 'z', 'w'][slot.channelIndex];
  return `texture(u_feedback${slot.textureIndex}, uv).${channel}`;
}

function formatFloat(value: number): string {
  if (!Number.isFinite(value)) return '0.0';
  if (Object.is(value, -0)) return '0.0';
  const text = Number(value).toString();
  return text.includes('.') || text.includes('e') ? text : `${text}.0`;
}

function buildShader(
  r: string,
  g: string,
  b: string,
  outputNodeId: string,
  target: GlslTarget,
  statements: GlslStatement[],
  feedbackExpressions: string[],
  feedbackSlots: FeedbackSlot[],
  feedbackTextureCount: number,
  shaderArgs: ShaderArg[],
  delaySlots: ShaderDelaySlot[],
  delayExpressions: string[],
  bufferSlots: ShaderBufferSlot[],
  bufferExpressions: string[],
  envelopeSlots: ShaderEnvelopeSlot[],
  envelopeExpressions: string[],
  scopeSlots: ShaderScopeSlot[],
  scopeExpressions: string[],
  meterSlots: ShaderMeterSlot[],
  meterExpressions: string[],
  media: ShaderMediaRequirements,
): string {
  const hasFeedback = feedbackTextureCount > 0;
  const hasStateOutputs = hasFeedback || delaySlots.length > 0 || bufferSlots.length > 0 || envelopeSlots.length > 0 || scopeSlots.length > 0 || meterSlots.length > 0;
  const fragmentOutput = hasStateOutputs ? 'layout(location = 0) out vec4 fragColor;' : 'out vec4 fragColor;';
  const feedbackOutputs = Array.from({ length: feedbackTextureCount }, (_, index) =>
    `layout(location = ${index + 1}) out vec4 feedbackColor${index};`,
  ).join('\n');
  const delayOutputs = delaySlots.map((slot, index) =>
    `layout(location = ${feedbackTextureCount + index + 1}) out vec4 delayColor${index};`,
  ).join('\n');
  const bufferOutputOffset = feedbackTextureCount + delaySlots.length + 1;
  const bufferOutputs = bufferSlots.map((slot, index) =>
    `layout(location = ${bufferOutputOffset + index}) out vec2 bufferColor${index};`,
  ).join('\n');
  const envelopeOutputOffset = bufferOutputOffset + bufferSlots.length;
  const envelopeOutputs = envelopeSlots.map((slot, index) =>
    `layout(location = ${envelopeOutputOffset + index}) out vec4 envelopeColor${index};`,
  ).join('\n');
  const scopeOutputOffset = envelopeOutputOffset + envelopeSlots.length;
  const scopeOutputs = scopeSlots.map((slot, index) =>
    `layout(location = ${scopeOutputOffset + index}) out vec4 scopeColor${index};`,
  ).join('\n');
  const meterOutputOffset = scopeOutputOffset + scopeSlots.length;
  const meterOutputs = meterSlots.map((slot, index) =>
    `layout(location = ${meterOutputOffset + index}) out float meterValue${index};`,
  ).join('\n');
  const header =
    target === 'webgl2'
      ? `#version 300 es
precision highp float;
precision highp int;
${fragmentOutput}
${feedbackOutputs}
${delayOutputs}
${bufferOutputs}
${envelopeOutputs}
${scopeOutputs}
${meterOutputs}`
      : `#version 330 core
${fragmentOutput}
${feedbackOutputs}
${delayOutputs}
${bufferOutputs}
${envelopeOutputs}
${scopeOutputs}
${meterOutputs}
`;
  const feedbackUniforms = Array.from({ length: feedbackTextureCount }, (_, index) =>
    `uniform sampler2D u_feedback${index};`,
  ).join('\n');
  const delayUniforms = delaySlots
    .map((slot) => `uniform sampler2D ${slot.samplerName};`)
    .join('\n');
  const bufferUniforms = bufferSlots
    .map((slot) => `uniform sampler2D ${slot.samplerName};`)
    .join('\n');
  const envelopeUniforms = envelopeSlots
    .map((slot) => `uniform sampler2D ${slot.samplerName};`)
    .join('\n');
  const mediaUniforms = [
    media.useMic ? 'uniform float u_mic_level;' : '',
    media.useCamera ? 'uniform sampler2D u_camera;' : '',
  ].filter(Boolean).join('\n');
  const shaderArgUniforms = shaderArgs
    .map((arg) => `uniform float ${arg.name};`)
    .join('\n');
  const shaderArgBlock = shaderArgUniforms
    ? `// Unlinked scalar inputs are uniforms updated from the node UI.
${shaderArgUniforms}`
    : '';
  const intermediateStatements = statements
    .map((statement) => `  // ${formatCommentText(statement.nodeId)}
  float ${statement.variable} = ${statement.expression};`)
    .join('\n\n');
  const feedbackAssignments = Array.from({ length: feedbackTextureCount }, (_, textureIndex) => {
    const slots = feedbackSlots.filter((slot) => slot.textureIndex === textureIndex);
    const comments = slots
      .map((slot) => `  // feedback ${formatCommentText(slot.link.from.node)}.${formatCommentText(slot.link.from.port)} -> ${formatCommentText(slot.link.to.node)}.${formatCommentText(slot.link.to.port)}`)
      .join('\n');
    const values = Array.from({ length: 4 }, (_, channelIndex) =>
      feedbackExpressions[textureIndex * 4 + channelIndex] ?? '0.0',
    );
    return `${comments}
  feedbackColor${textureIndex} = vec4(${values.join(', ')});`;
  }).join('\n\n');
  const delayAssignments = delaySlots.map((slot, index) => `  // delay ${formatCommentText(slot.nodeId)}
  delayColor${index} = vec4(${delayExpressions[index] ?? '0.0'}, 0.0, 0.0, 1.0);`).join('\n\n');
  const bufferAssignments = bufferSlots.map((slot, index) => `  // buffer ${formatCommentText(slot.nodeId)}
  bufferColor${index} = ${bufferExpressions[index] ?? 'vec2(0.0)'};`).join('\n\n');
  const envelopeAssignments = envelopeSlots.map((slot, index) => `  // envelope ${formatCommentText(slot.nodeId)}
  envelopeColor${index} = vec4(${envelopeExpressions[index] ?? '0.0'}, 0.0, 0.0, 1.0);`).join('\n\n');
  const scopeAssignments = scopeSlots.map((slot, index) => `  // scope ${formatCommentText(slot.nodeId)}
  scopeColor${index} = scopePixel(${scopeExpressions[index] ?? '0.0'}, uv);`).join('\n\n');
  const meterAssignments = meterSlots.map((slot, index) => `  // meter ${formatCommentText(slot.nodeId)}
  meterValue${index} = ${meterExpressions[index] ?? '0.0'};`).join('\n\n');

  return `${header}
uniform vec2 u_resolution;
uniform float u_time;
uniform int u_frame;
${shaderArgBlock}
${feedbackUniforms}
${delayUniforms}
${bufferUniforms}
${envelopeUniforms}
${mediaUniforms}

vec3 hsvToRgb(vec3 hsv) {
  vec3 rgb = clamp(abs(mod(hsv.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  rgb = rgb * rgb * (3.0 - 2.0 * rgb);
  return hsv.z * mix(vec3(1.0), rgb, clamp(hsv.y, 0.0, 1.0));
}

vec2 noiseGradient(vec2 p) {
  float angle = 6.28318530718 * fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  return vec2(cos(angle), sin(angle));
}

float perlinNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

  float a = dot(noiseGradient(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0));
  float b = dot(noiseGradient(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
  float c = dot(noiseGradient(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
  float d = dot(noiseGradient(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));

  float x0 = mix(a, b, u.x);
  float x1 = mix(c, d, u.x);
  return 0.5 + 0.5 * mix(x0, x1, u.y);
}

float fbmNoise(vec2 p, float octaves) {
  float value = 0.0;
  float amplitude = 0.5;
  float total = 0.0;
  float octaveLimit = clamp(floor(octaves + 0.5), 1.0, 4.0);
  mat2 warp = mat2(1.6, 1.2, -1.2, 1.6);

  for (int octave = 0; octave < 4; octave++) {
    if (float(octave) >= octaveLimit) {
      break;
    }
    value += amplitude * perlinNoise(p);
    total += amplitude;
    p = warp * p + vec2(13.1, 17.7);
    amplitude *= 0.5;
  }

  return value / max(total, 0.0001);
}

vec3 noiseGradient3(vec3 p) {
  vec3 hash = fract(sin(vec3(
    dot(p, vec3(127.1, 311.7, 74.7)),
    dot(p, vec3(269.5, 183.3, 246.1)),
    dot(p, vec3(113.5, 271.9, 124.6))
  )) * 43758.5453123);
  return normalize(hash * 2.0 - 1.0 + vec3(0.0001));
}

float perlinNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

  float n000 = dot(noiseGradient3(i + vec3(0.0, 0.0, 0.0)), f - vec3(0.0, 0.0, 0.0));
  float n100 = dot(noiseGradient3(i + vec3(1.0, 0.0, 0.0)), f - vec3(1.0, 0.0, 0.0));
  float n010 = dot(noiseGradient3(i + vec3(0.0, 1.0, 0.0)), f - vec3(0.0, 1.0, 0.0));
  float n110 = dot(noiseGradient3(i + vec3(1.0, 1.0, 0.0)), f - vec3(1.0, 1.0, 0.0));
  float n001 = dot(noiseGradient3(i + vec3(0.0, 0.0, 1.0)), f - vec3(0.0, 0.0, 1.0));
  float n101 = dot(noiseGradient3(i + vec3(1.0, 0.0, 1.0)), f - vec3(1.0, 0.0, 1.0));
  float n011 = dot(noiseGradient3(i + vec3(0.0, 1.0, 1.0)), f - vec3(0.0, 1.0, 1.0));
  float n111 = dot(noiseGradient3(i + vec3(1.0, 1.0, 1.0)), f - vec3(1.0, 1.0, 1.0));

  float nx00 = mix(n000, n100, u.x);
  float nx10 = mix(n010, n110, u.x);
  float nx01 = mix(n001, n101, u.x);
  float nx11 = mix(n011, n111, u.x);
  float nxy0 = mix(nx00, nx10, u.y);
  float nxy1 = mix(nx01, nx11, u.y);
  return 0.5 + 0.5 * mix(nxy0, nxy1, u.z);
}

float fbmNoise3(vec3 p, float octaves) {
  float value = 0.0;
  float amplitude = 0.5;
  float total = 0.0;
  float octaveLimit = clamp(floor(octaves + 0.5), 1.0, 4.0);
  mat3 warp = mat3(
    1.4, 1.0, 0.8,
    -0.8, 1.5, 0.6,
    0.6, -0.7, 1.6
  );

  for (int octave = 0; octave < 4; octave++) {
    if (float(octave) >= octaveLimit) {
      break;
    }
    value += amplitude * perlinNoise3(p);
    total += amplitude;
    p = warp * p + vec3(13.1, 17.7, 23.3);
    amplitude *= 0.5;
  }

  return value / max(total, 0.0001);
}

float hashNoise3Fast(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float valueNoise3Fast(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);

  float n000 = hashNoise3Fast(i + vec3(0.0, 0.0, 0.0));
  float n100 = hashNoise3Fast(i + vec3(1.0, 0.0, 0.0));
  float n010 = hashNoise3Fast(i + vec3(0.0, 1.0, 0.0));
  float n110 = hashNoise3Fast(i + vec3(1.0, 1.0, 0.0));
  float n001 = hashNoise3Fast(i + vec3(0.0, 0.0, 1.0));
  float n101 = hashNoise3Fast(i + vec3(1.0, 0.0, 1.0));
  float n011 = hashNoise3Fast(i + vec3(0.0, 1.0, 1.0));
  float n111 = hashNoise3Fast(i + vec3(1.0, 1.0, 1.0));

  float nx00 = mix(n000, n100, u.x);
  float nx10 = mix(n010, n110, u.x);
  float nx01 = mix(n001, n101, u.x);
  float nx11 = mix(n011, n111, u.x);
  float nxy0 = mix(nx00, nx10, u.y);
  float nxy1 = mix(nx01, nx11, u.y);
  return mix(nxy0, nxy1, u.z);
}

float fbmNoise3Fast(vec3 p, float octaves) {
  float value = 0.0;
  float amplitude = 0.5;
  float total = 0.0;
  float octaveLimit = clamp(floor(octaves + 0.5), 1.0, 4.0);

  for (int octave = 0; octave < 4; octave++) {
    if (float(octave) >= octaveLimit) {
      break;
    }
    value += amplitude * valueNoise3Fast(p);
    total += amplitude;
    p = p * 2.03 + vec3(13.1, 17.7, 23.3);
    amplitude *= 0.5;
  }

  return value / max(total, 0.0001);
}

vec4 scopePixel(float value, vec2 uv) {
  float normalized = clamp(value, 0.0, 1.0);
  return vec4(vec3(normalized), 1.0);
}

void main() {
  vec2 uv = gl_FragCoord.xy / max(u_resolution, vec2(1.0));
  float x = uv.x;
  float y = uv.y;
${intermediateStatements ? `\n${intermediateStatements}\n` : ''}
  // ${formatCommentText(outputNodeId)}
  float r = ${r};
  float g = ${g};
  float b = ${b};

  fragColor = vec4(r, g, b, 1.0);
${feedbackAssignments ? `\n${feedbackAssignments}` : ''}
${delayAssignments ? `\n${delayAssignments}` : ''}
${bufferAssignments ? `\n${bufferAssignments}` : ''}
${envelopeAssignments ? `\n${envelopeAssignments}` : ''}
${scopeAssignments ? `\n${scopeAssignments}` : ''}
${meterAssignments ? `\n${meterAssignments}` : ''}
}
`;
}

function makeVariableName(nodeId: string, port: string, usedVariables: Set<string>): string {
  const base = toGlslIdentifier(`${nodeId}_${port}`);
  let candidate = base;
  let index = 2;
  while (usedVariables.has(candidate)) {
    candidate = `${base}_${index}`;
    index += 1;
  }
  usedVariables.add(candidate);
  return candidate;
}

function collectShaderArgs(patch: Patch, incoming: Map<string, PatchLink[]>): ShaderArg[] {
  const usedNames = new Set<string>();
  const args: ShaderArg[] = [];

  for (const node of patch.nodes) {
    const definition = getNodeDefinition(node);
    for (const input of definition.inputs) {
      const inputLinks = incoming.get(`${node.id}.${input.name}`) ?? [];
      if (node.type === 'Meter' && input.name === 'value' && inputLinks.length === 0) continue;
      if (inputLinks.some((link) => (link.mode ?? 'set') === 'set')) continue;

      args.push({
        name: makeShaderArgName(node.id, input.name, usedNames),
        value: node.params[input.name] ?? input.defaultValue ?? 0,
        nodeId: node.id,
        port: input.name,
      });
    }
  }

  for (const link of patch.links) {
    const key = linkKey(link);
    args.push({
      name: makeShaderArgName(`edge_${key}`, 'weight', usedNames),
      value: link.weight ?? 1,
      nodeId: key,
      port: 'weight',
    });
  }

  return args;
}

function collectDelaySlots(patch: Patch, shaderArgs: ShaderArg[]): ShaderDelaySlot[] {
  return patch.nodes
    .filter((node) => node.type === 'Delay')
    .map((node) => {
      const frameArg = shaderArgs.find((arg) => arg.nodeId === node.id && arg.port === 'frames');
      if (!frameArg) {
        throw new Error(`Delay node "${node.id}" needs an unlinked scalar "frames" input.`);
      }

      return {
        nodeId: node.id,
        samplerName: `u_delay_${toGlslIdentifier(node.id)}`,
        frameArgName: frameArg.name,
      };
    });
}

function collectBufferSlots(patch: Patch): ShaderBufferSlot[] {
  return patch.nodes
    .filter((node) => node.type === 'Buffer')
    .map((node) => ({
      nodeId: node.id,
      samplerName: `u_buffer_${toGlslIdentifier(node.id)}`,
    }));
}

function collectEnvelopeSlots(patch: Patch): ShaderEnvelopeSlot[] {
  return patch.nodes
    .filter((node) => node.type === 'Envelope')
    .map((node) => ({
      nodeId: node.id,
      samplerName: `u_envelope_${toGlslIdentifier(node.id)}`,
    }));
}

function collectScopeSlots(patch: Patch): ShaderScopeSlot[] {
  return patch.nodes
    .filter((node) => node.type === 'Scope')
    .map((node) => ({
      nodeId: node.id,
    }));
}

function collectMeterSlots(patch: Patch, incoming: Map<string, PatchLink[]>): ShaderMeterSlot[] {
  return patch.nodes
    .filter((node) => node.type === 'Meter' && (incoming.get(`${node.id}.value`) ?? []).length > 0)
    .map((node) => ({
      nodeId: node.id,
    }));
}

function emptyMediaRequirements(): ShaderMediaRequirements {
  return {
    useMic: false,
    useCamera: false,
  };
}

function makeShaderArgName(nodeId: string, port: string, usedNames: Set<string>): string {
  const base = `u_arg_${toGlslIdentifier(`${nodeId}_${port}`)}`;
  let candidate = base;
  let index = 2;
  while (usedNames.has(candidate)) {
    candidate = `${base}_${index}`;
    index += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function toGlslIdentifier(value: string): string {
  const identifier = value
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!identifier) return 'node';
  return /^[0-9]/.test(identifier) ? `v_${identifier}` : identifier;
}

function formatCommentText(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/\*\//g, '* /');
}

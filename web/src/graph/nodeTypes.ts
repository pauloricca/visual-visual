import type { NodeDefinition, NodeType, PatchNode } from './types';

export const NODE_DEFINITIONS: Record<NodeType, NodeDefinition> = {
  System: {
    type: 'System',
    inputs: [],
    outputs: [
      { name: 'x' },
      { name: 'y' },
      { name: 'time' },
      { name: 'frame' },
      { name: 'mic' },
    ],
  },
  Output: {
    type: 'Output',
    inputs: [
      { name: 'r', defaultValue: 0 },
      { name: 'g', defaultValue: 0 },
      { name: 'b', defaultValue: 0 },
    ],
    outputs: [
      { name: 'r' },
      { name: 'g' },
      { name: 'b' },
    ],
  },
  Expression: {
    type: 'Expression',
    inputs: [],
    outputs: [{ name: 'value' }],
  },
  Constant: {
    type: 'Constant',
    inputs: [{ name: 'value', defaultValue: 1 }],
    outputs: [{ name: 'value' }],
  },
  Add: binary('Add', 0, 0),
  Subtract: binary('Subtract', 0, 0),
  Multiply: binary('Multiply', 0, 1),
  Divide: binary('Divide', 0, 1),
  Mod: binary('Mod', 0, 1),
  Pow: binary('Pow', 1, 1),
  Sin: unary('Sin'),
  Cos: unary('Cos'),
  Tan: unary('Tan'),
  sinh: unary('sinh'),
  cosh: unary('cosh'),
  tanh: unary('tanh'),
  Atan: unary('Atan'),
  Abs: unary('Abs'),
  Floor: unary('Floor'),
  Fract: unary('Fract'),
  Step: {
    type: 'Step',
    inputs: [
      { name: 'value', defaultValue: 0 },
      { name: 'edge', defaultValue: 0.5 },
    ],
    outputs: [{ name: 'value' }],
  },
  Smoothstep: {
    type: 'Smoothstep',
    inputs: [
      { name: 'value', defaultValue: 0 },
      { name: 'edge0', defaultValue: 0 },
      { name: 'edge1', defaultValue: 1 },
    ],
    outputs: [{ name: 'value' }],
  },
  Mix: {
    type: 'Mix',
    inputs: [
      { name: 'a', defaultValue: 0 },
      { name: 'b', defaultValue: 1 },
      { name: 'amount', defaultValue: 0.5 },
    ],
    outputs: [{ name: 'value' }],
  },
  Map: {
    type: 'Map',
    inputs: [
      { name: 'value', defaultValue: 0 },
      { name: 'srcMin', defaultValue: 0 },
      { name: 'srcMax', defaultValue: 1 },
      { name: 'trgtMin', defaultValue: 0 },
      { name: 'trgtMax', defaultValue: 1 },
    ],
    outputs: [{ name: 'value' }],
  },
  Min: binary('Min', 0, 1),
  Max: binary('Max', 0, 1),
  Clamp: {
    type: 'Clamp',
    inputs: [
      { name: 'value', defaultValue: 0 },
      { name: 'min', defaultValue: 0 },
      { name: 'max', defaultValue: 1 },
    ],
    outputs: [{ name: 'value' }],
  },
  Saw: oscillator('Saw'),
  Ramp: oscillator('Ramp'),
  Pulse: {
    type: 'Pulse',
    inputs: [
      { name: 'frequency', defaultValue: 1 },
      { name: 'phase', defaultValue: 0 },
      { name: 'width', defaultValue: 0.5 },
    ],
    outputs: [{ name: 'value' }],
  },
  Triangle: oscillator('Triangle'),
  Polar: {
    type: 'Polar',
    inputs: [
      { name: 'radius', defaultValue: 1 },
      { name: 'angle', defaultValue: 0 },
    ],
    outputs: [
      { name: 'x' },
      { name: 'y' },
    ],
  },
  toPolar: {
    type: 'toPolar',
    inputs: [
      { name: 'x', defaultValue: 0 },
      { name: 'y', defaultValue: 0 },
    ],
    outputs: [
      { name: 'radius' },
      { name: 'angle' },
    ],
  },
  HSV: {
    type: 'HSV',
    inputs: [
      { name: 'h', defaultValue: 0 },
      { name: 's', defaultValue: 1 },
      { name: 'v', defaultValue: 1 },
    ],
    outputs: [
      { name: 'r' },
      { name: 'g' },
      { name: 'b' },
    ],
  },
  Gate: {
    type: 'Gate',
    inputs: [
      { name: 'value', defaultValue: 0 },
      { name: 'gate', defaultValue: 0 },
      { name: 'min', defaultValue: 0.5 },
      { name: 'max', defaultValue: 1 },
    ],
    outputs: [{ name: 'value' }],
  },
  Rotate: {
    type: 'Rotate',
    inputs: [
      { name: 'x', defaultValue: 0 },
      { name: 'y', defaultValue: 0 },
      { name: 'angle', defaultValue: 0 },
    ],
    outputs: [
      { name: 'x' },
      { name: 'y' },
    ],
  },
  complexMul: {
    type: 'complexMul',
    inputs: [
      { name: 'ax', defaultValue: 0 },
      { name: 'ay', defaultValue: 0 },
      { name: 'bx', defaultValue: 1 },
      { name: 'by', defaultValue: 0 },
    ],
    outputs: [
      { name: 'outX' },
      { name: 'outY' },
      { name: 'distance' },
      { name: 'angle' },
    ],
  },
  complexDiv: {
    type: 'complexDiv',
    inputs: [
      { name: 'ax', defaultValue: 0 },
      { name: 'ay', defaultValue: 0 },
      { name: 'bx', defaultValue: 1 },
      { name: 'by', defaultValue: 0 },
    ],
    outputs: [
      { name: 'outX' },
      { name: 'outY' },
      { name: 'distance' },
      { name: 'angle' },
      { name: 'mask' },
    ],
  },
  complexPow: {
    type: 'complexPow',
    inputs: [
      { name: 'zx', defaultValue: 0 },
      { name: 'zy', defaultValue: 0 },
      { name: 'power', defaultValue: 2 },
    ],
    outputs: [
      { name: 'outX' },
      { name: 'outY' },
      { name: 'distance' },
      { name: 'angle' },
    ],
  },
  mobius: {
    type: 'mobius',
    inputs: [
      { name: 'zx', defaultValue: 0 },
      { name: 'zy', defaultValue: 0 },
      { name: 'ax', defaultValue: 1 },
      { name: 'ay', defaultValue: 0 },
      { name: 'bx', defaultValue: 0 },
      { name: 'by', defaultValue: 0 },
      { name: 'cx', defaultValue: 0 },
      { name: 'cy', defaultValue: 0 },
      { name: 'dx', defaultValue: 1 },
      { name: 'dy', defaultValue: 0 },
    ],
    outputs: [
      { name: 'outX' },
      { name: 'outY' },
      { name: 'distance' },
      { name: 'angle' },
      { name: 'mask' },
    ],
  },
  circleInvert: {
    type: 'circleInvert',
    inputs: [
      { name: 'x', defaultValue: 0 },
      { name: 'y', defaultValue: 0 },
      { name: 'radius', defaultValue: 0.5 },
      { name: 'strength', defaultValue: 1 },
    ],
    outputs: [
      { name: 'outX' },
      { name: 'outY' },
      { name: 'value' },
      { name: 'distance' },
      { name: 'angle' },
      { name: 'mask' },
    ],
  },
  polarRepeat: {
    type: 'polarRepeat',
    inputs: [
      { name: 'x', defaultValue: 0 },
      { name: 'y', defaultValue: 0 },
      { name: 'sectors', defaultValue: 6, min: 1, max: 64, integer: true },
      { name: 'offset', defaultValue: 0 },
    ],
    outputs: [
      { name: 'outX' },
      { name: 'outY' },
      { name: 'value' },
      { name: 'distance' },
      { name: 'angle' },
      { name: 'mask' },
    ],
  },
  logPolar: {
    type: 'logPolar',
    inputs: [
      { name: 'x', defaultValue: 0 },
      { name: 'y', defaultValue: 0 },
      { name: 'radialScale', defaultValue: 1 },
      { name: 'angleScale', defaultValue: 1 },
    ],
    outputs: [
      { name: 'outX' },
      { name: 'outY' },
      { name: 'value' },
      { name: 'distance' },
      { name: 'angle' },
      { name: 'mask' },
    ],
  },
  domainWarp: {
    type: 'domainWarp',
    inputs: [
      { name: 'x', defaultValue: 0 },
      { name: 'y', defaultValue: 0 },
      { name: 'amount', defaultValue: 0.1 },
      { name: 'freq', defaultValue: 8 },
      { name: 'phase', defaultValue: 0 },
    ],
    outputs: [
      { name: 'outX' },
      { name: 'outY' },
      { name: 'value' },
      { name: 'distance' },
      { name: 'angle' },
      { name: 'mask' },
    ],
  },
  foldSymmetry: {
    type: 'foldSymmetry',
    inputs: [
      { name: 'x', defaultValue: 0 },
      { name: 'y', defaultValue: 0 },
      { name: 'angle', defaultValue: 0.523599 },
      { name: 'iterations', defaultValue: 6, min: 0, max: 32, integer: true },
    ],
    outputs: [
      { name: 'outX' },
      { name: 'outY' },
      { name: 'value' },
      { name: 'distance' },
      { name: 'angle' },
      { name: 'mask' },
    ],
  },
  juliaOrbitTrap: {
    type: 'juliaOrbitTrap',
    inputs: [
      { name: 'x', defaultValue: 0 },
      { name: 'y', defaultValue: 0 },
      { name: 'cx', defaultValue: -0.8 },
      { name: 'cy', defaultValue: 0.156 },
      { name: 'iterations', defaultValue: 32, min: 0, max: 128, integer: true },
      { name: 'bailout', defaultValue: 4 },
    ],
    outputs: [
      { name: 'outX' },
      { name: 'outY' },
      { name: 'value' },
      { name: 'minRadius' },
      { name: 'escape' },
      { name: 'iteration' },
      { name: 'distance' },
      { name: 'angle' },
      { name: 'mask' },
    ],
  },
  Quantise: {
    type: 'Quantise',
    inputs: [
      { name: 'value', defaultValue: 0 },
      { name: 'levels', defaultValue: 8 },
    ],
    outputs: [{ name: 'value' }],
  },
  Distance: {
    type: 'Distance',
    inputs: [
      { name: 'x1', defaultValue: 0 },
      { name: 'y1', defaultValue: 0 },
      { name: 'x2', defaultValue: 0 },
      { name: 'y2', defaultValue: 0 },
    ],
    outputs: [{ name: 'value' }],
  },
  Noise: {
    type: 'Noise',
    inputs: [
      { name: 'x', defaultValue: 0 },
      { name: 'y', defaultValue: 0 },
      { name: 'scale', defaultValue: 12 },
      { name: 'seed', defaultValue: 0 },
      { name: 'octaves', defaultValue: 4, min: 1, max: 4, integer: true },
    ],
    outputs: [{ name: 'value' }],
  },
  Noise3: {
    type: 'Noise3',
    inputs: [
      { name: 'x', defaultValue: 0 },
      { name: 'y', defaultValue: 0 },
      { name: 'z', defaultValue: 0 },
      { name: 'scale', defaultValue: 12 },
      { name: 'seed', defaultValue: 0 },
      { name: 'octaves', defaultValue: 4, min: 1, max: 4, integer: true },
    ],
    outputs: [{ name: 'value' }],
  },
  Noise3Fast: {
    type: 'Noise3Fast',
    inputs: [
      { name: 'x', defaultValue: 0 },
      { name: 'y', defaultValue: 0 },
      { name: 'z', defaultValue: 0 },
      { name: 'scale', defaultValue: 12 },
      { name: 'seed', defaultValue: 0 },
      { name: 'octaves', defaultValue: 3, min: 1, max: 4, integer: true },
    ],
    outputs: [{ name: 'value' }],
  },
  Buffer: {
    type: 'Buffer',
    inputs: [
      { name: 'inX', defaultValue: 0 },
      { name: 'inY', defaultValue: 0 },
      { name: 'outX', defaultValue: 0 },
      { name: 'outY', defaultValue: 0 },
    ],
    outputs: [
      { name: 'x' },
      { name: 'y' },
    ],
  },
  Delay: {
    type: 'Delay',
    inputs: [
      { name: 'value', defaultValue: 0 },
      { name: 'frames', defaultValue: 1, connectable: false, min: 1, max: 32, integer: true },
    ],
    outputs: [{ name: 'value' }],
  },
  midiCC: {
    type: 'midiCC',
    inputs: [
      { name: 'cc', defaultValue: 1, connectable: false, min: 0, max: 127, integer: true },
      { name: 'channel', defaultValue: 1, connectable: false, min: 1, max: 16, integer: true },
      { name: 'value', defaultValue: 0, connectable: false, min: 0, max: 1 },
    ],
    outputs: [{ name: 'value' }],
  },
  Envelope: {
    type: 'Envelope',
    inputs: [
      { name: 'value', defaultValue: 0 },
      { name: 'attack', defaultValue: 4 },
      { name: 'release', defaultValue: 16 },
    ],
    outputs: [{ name: 'value' }],
  },
  Scope: {
    type: 'Scope',
    inputs: [{ name: 'value', defaultValue: 0 }],
    outputs: [],
  },
  Meter: {
    type: 'Meter',
    inputs: [{ name: 'value', defaultValue: 0 }],
    outputs: [],
  },
  Group: {
    type: 'Group',
    inputs: [],
    outputs: [],
  },
  Ins: {
    type: 'Ins',
    inputs: [],
    outputs: [],
  },
  Outs: {
    type: 'Outs',
    inputs: [],
    outputs: [],
  },
  Camera: {
    type: 'Camera',
    inputs: [
      { name: 'x', defaultValue: 0 },
      { name: 'y', defaultValue: 0 },
    ],
    outputs: [
      { name: 'r' },
      { name: 'g' },
      { name: 'b' },
    ],
  },
};

const NODE_TYPE_LABELS: Partial<Record<NodeType, string>> = {
  System: 'Sys ins',
  Output: 'Sys outs',
  Group: 'Group',
  Ins: 'Ins',
  Outs: 'Outs',
  midiCC: 'MIDI CC',
};

export const NODE_TYPE_LIST = Object.keys(NODE_DEFINITIONS) as NodeType[];

export function getNodeTypeLabel(type: NodeType): string {
  return NODE_TYPE_LABELS[type] ?? type;
}

export function getDefinition(type: NodeType): NodeDefinition {
  return NODE_DEFINITIONS[type];
}

export function getNodeDefinition(node: Pick<PatchNode, 'type' | 'inputs' | 'outputs'>): NodeDefinition {
  if (node.type === 'Expression') {
    return {
      type: node.type,
      inputs: node.inputs ?? [],
      outputs: getDefinition(node.type).outputs,
    };
  }

  if (node.type === 'Group') {
    return {
      type: node.type,
      inputs: node.inputs ?? [],
      outputs: node.outputs ?? [],
    };
  }

  if (node.type === 'Ins') {
    return {
      type: node.type,
      inputs: [],
      outputs: node.outputs ?? [],
    };
  }

  if (node.type === 'Outs') {
    return {
      type: node.type,
      inputs: node.inputs ?? [],
      outputs: [],
    };
  }

  return getDefinition(node.type);
}

export function hasInput(type: NodeType, port: string): boolean {
  return NODE_DEFINITIONS[type].inputs.some((input) => input.name === port);
}

export function nodeHasInput(node: Pick<PatchNode, 'type' | 'inputs' | 'outputs'>, port: string): boolean {
  return getNodeDefinition(node).inputs.some((input) => input.name === port);
}

export function acceptsInputLink(type: NodeType, port: string): boolean {
  return NODE_DEFINITIONS[type].inputs.some((input) => (
    input.name === port &&
    input.connectable !== false
  ));
}

export function nodeAcceptsInputLink(node: Pick<PatchNode, 'type' | 'inputs' | 'outputs'>, port: string): boolean {
  return getNodeDefinition(node).inputs.some((input) => (
    input.name === port &&
    input.connectable !== false
  ));
}

export function hasOutput(type: NodeType, port: string): boolean {
  return NODE_DEFINITIONS[type].outputs.some((output) => output.name === port);
}

export function nodeHasOutput(node: Pick<PatchNode, 'type' | 'inputs' | 'outputs'>, port: string): boolean {
  return getNodeDefinition(node).outputs.some((output) => output.name === port);
}

export function defaultParamsFor(type: NodeType): Record<string, number> {
  return Object.fromEntries(
    NODE_DEFINITIONS[type].inputs.map((input) => [
      input.name,
      input.defaultValue ?? 0,
    ]),
  );
}

function unary(type: NodeType): NodeDefinition {
  return {
    type,
    inputs: [{ name: 'value', defaultValue: 0 }],
    outputs: [{ name: 'value' }],
  };
}

function binary(type: NodeType, a: number, b: number): NodeDefinition {
  return {
    type,
    inputs: [
      { name: 'a', defaultValue: a },
      { name: 'b', defaultValue: b },
    ],
    outputs: [{ name: 'value' }],
  };
}

function oscillator(type: NodeType): NodeDefinition {
  return {
    type,
    inputs: [
      { name: 'frequency', defaultValue: 1 },
      { name: 'phase', defaultValue: 0 },
    ],
    outputs: [{ name: 'value' }],
  };
}

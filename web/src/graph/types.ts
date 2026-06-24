export type NodeType =
  | 'System'
  | 'Output'
  | 'Expression'
  | 'Constant'
  | 'Add'
  | 'Subtract'
  | 'Multiply'
  | 'Divide'
  | 'Mod'
  | 'Pow'
  | 'Sin'
  | 'Cos'
  | 'Tan'
  | 'sinh'
  | 'cosh'
  | 'tanh'
  | 'Atan'
  | 'Abs'
  | 'Floor'
  | 'Fract'
  | 'Step'
  | 'Smoothstep'
  | 'Mix'
  | 'Map'
  | 'Min'
  | 'Max'
  | 'Clamp'
  | 'Saw'
  | 'Ramp'
  | 'Pulse'
  | 'Triangle'
  | 'Polar'
  | 'toPolar'
  | 'HSV'
  | 'Gate'
  | 'Rotate'
  | 'complexMul'
  | 'complexDiv'
  | 'complexPow'
  | 'mobius'
  | 'circleInvert'
  | 'polarRepeat'
  | 'logPolar'
  | 'domainWarp'
  | 'foldSymmetry'
  | 'juliaOrbitTrap'
  | 'Quantise'
  | 'Distance'
  | 'Noise'
  | 'Noise3'
  | 'Noise3Fast'
  | 'Buffer'
  | 'Delay'
  | 'midiCC'
  | 'Camera'
  | 'Envelope'
  | 'Scope'
  | 'Meter'
  | 'Group'
  | 'Ins'
  | 'Outs';

export interface Vec2 {
  x: number;
  y: number;
}

export interface PatchNode {
  id: string;
  type: NodeType;
  subpatchName?: string;
  subpatchCloneId?: string;
  expression?: string;
  params: Record<string, number>;
  position?: Vec2;
  inputs?: PortDefinition[];
  outputs?: PortDefinition[];
  subpatch?: Patch;
}

export interface Endpoint {
  node: string;
  port: string;
}

export type LinkMode = 'set' | 'add' | 'multiply';

export interface PatchLink {
  from: Endpoint;
  to: Endpoint;
  weight?: number;
  mode?: LinkMode;
}

export interface Patch {
  nodes: PatchNode[];
  links: PatchLink[];
  name?: string;
}

export interface PortDefinition {
  name: string;
  defaultValue?: number;
  connectable?: boolean;
  min?: number;
  max?: number;
  integer?: boolean;
}

export interface NodeDefinition {
  type: NodeType;
  inputs: PortDefinition[];
  outputs: PortDefinition[];
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

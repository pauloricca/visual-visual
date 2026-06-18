export type NodeType =
  | 'System'
  | 'Output'
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
  | 'Atan'
  | 'Abs'
  | 'Floor'
  | 'Fract'
  | 'Step'
  | 'Smoothstep'
  | 'Mix'
  | 'Min'
  | 'Max'
  | 'Clamp'
  | 'Saw'
  | 'Ramp'
  | 'Pulse'
  | 'Triangle'
  | 'Polar'
  | 'HSV'
  | 'Gate'
  | 'Rotate'
  | 'Quantise'
  | 'Distance'
  | 'Noise'
  | 'Delay'
  | 'Camera'
  | 'Envelope';

export interface Vec2 {
  x: number;
  y: number;
}

export interface PatchNode {
  id: string;
  type: NodeType;
  params: Record<string, number>;
  position?: Vec2;
}

export interface Endpoint {
  node: string;
  port: string;
}

export interface PatchLink {
  from: Endpoint;
  to: Endpoint;
  weight?: number;
}

export interface Patch {
  nodes: PatchNode[];
  links: PatchLink[];
}

export interface PortDefinition {
  name: string;
  defaultValue?: number;
  connectable?: boolean;
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

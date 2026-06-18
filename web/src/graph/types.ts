export type NodeType =
  | 'System'
  | 'Output'
  | 'Constant'
  | 'Add'
  | 'Subtract'
  | 'Multiply'
  | 'Divide'
  | 'Mod'
  | 'Sin'
  | 'Cos'
  | 'Abs'
  | 'Floor'
  | 'Fract'
  | 'Step'
  | 'Smoothstep'
  | 'Mix'
  | 'Min'
  | 'Max'
  | 'Clamp'
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

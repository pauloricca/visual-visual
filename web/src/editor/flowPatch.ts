import type { Edge, Node } from '@xyflow/react';
import type { LinkMode, NodeType, Patch, PatchLink, PatchNode } from '../graph/types';

export type EditorPatchNode = Omit<PatchNode, 'type'> & {
  type: NodeType | null;
};

export interface ShaderNodeData extends Record<string, unknown> {
  patchNode: EditorPatchNode;
  onParamChange: (nodeId: string, port: string, value: number) => void;
  onExpressionChange?: (nodeId: string, expression: string) => void;
  onExpressionCommit?: (nodeId: string, expression: string) => void;
  onTypeChange: (nodeId: string, type: NodeType) => void;
  onTypeEditStart: (nodeId: string) => void;
  onTypeEditEnd: () => void;
  onIdChange: (nodeId: string, nextId: string) => void;
  onPortDoubleClick: (nodeId: string, side: 'input' | 'output', port: string) => void;
  onPortNameChange: (nodeId: string, side: 'input' | 'output', port: string, nextPort: string) => void;
  onPortMove: (nodeId: string, side: 'input' | 'output', port: string, direction: -1 | 1) => void;
  onPortSelect?: (nodeId: string, side: 'input' | 'output', port: string) => void;
  selectedPort?: { side: 'input' | 'output'; name: string } | null;
  previewPort?: { side: 'input' | 'output'; name: string } | null;
  isTypePickerOpen: boolean;
}

export type ShaderFlowNode = Node<ShaderNodeData, 'shaderNode'>;

export interface ShaderEdgeData extends Record<string, unknown> {
  weight: number;
  mode: LinkMode;
  onWeightChange: (edgeId: string, weight: number) => void;
  onModeChange: (edgeId: string, mode: LinkMode) => void;
  onInsertNode: (edgeId: string) => void;
  showLinkControls?: boolean;
  isFeedback?: boolean;
}

export type ShaderFlowEdge = Edge<ShaderEdgeData, 'shaderEdge'>;

export interface PersistedEditorState {
  version: 1;
  ui?: {
    patchName?: string;
    visualizationVisible?: boolean;
    sidePanelOpen?: boolean;
    exportPanelView?: 'glsl' | 'json';
    viewport?: {
      x: number;
      y: number;
      zoom: number;
    };
  };
  nodes: Array<{
    id: string;
    type: NodeType | null;
    subpatchName?: string;
    subpatchCloneId?: string;
    expression?: string;
    params: Record<string, number>;
    position: { x: number; y: number };
    inputs?: PatchNode['inputs'];
    outputs?: PatchNode['outputs'];
    subpatch?: Patch;
  }>;
  edges: Array<{
    id: string;
    source: string;
    sourceHandle: string | null;
    target: string;
    targetHandle: string | null;
    weight?: number;
    mode?: LinkMode;
  }>;
}

export function toFlowNodes(
  patch: Patch,
  onParamChange: ShaderNodeData['onParamChange'],
  onTypeChange: ShaderNodeData['onTypeChange'],
  onTypeEditStart: ShaderNodeData['onTypeEditStart'],
  onTypeEditEnd: ShaderNodeData['onTypeEditEnd'],
  onIdChange: ShaderNodeData['onIdChange'],
  onPortDoubleClick: ShaderNodeData['onPortDoubleClick'],
  onPortNameChange: ShaderNodeData['onPortNameChange'],
  onPortMove: ShaderNodeData['onPortMove'],
  editingTypeNodeId: string | null,
): ShaderFlowNode[] {
  return patch.nodes.map((patchNode) => ({
    id: patchNode.id,
    type: 'shaderNode',
    position: patchNode.position ?? { x: 0, y: 0 },
    data: {
      patchNode,
      onParamChange,
      onTypeChange,
      onTypeEditStart,
      onTypeEditEnd,
      onIdChange,
      onPortDoubleClick,
      onPortNameChange,
      onPortMove,
      isTypePickerOpen: editingTypeNodeId === patchNode.id,
    },
  }));
}

export function toFlowEdges(
  patch: Patch,
  onWeightChange: ShaderEdgeData['onWeightChange'],
  onInsertNode: ShaderEdgeData['onInsertNode'] = noopInsertNode,
): ShaderFlowEdge[] {
  return patch.links.map((link) => ({
    id: edgeId(link),
    type: 'shaderEdge',
    source: link.from.node,
    sourceHandle: `out:${link.from.port}`,
    target: link.to.node,
    targetHandle: `in:${link.to.port}`,
    data: {
      weight: link.weight ?? 1,
      mode: link.mode ?? 'set',
      onWeightChange,
      onModeChange: noopModeChange,
      onInsertNode,
    },
    className: 'shader-edge',
  }));
}

export function editorStateToFlowNodes(
  state: PersistedEditorState,
  onParamChange: ShaderNodeData['onParamChange'],
  onTypeChange: ShaderNodeData['onTypeChange'],
  onTypeEditStart: ShaderNodeData['onTypeEditStart'],
  onTypeEditEnd: ShaderNodeData['onTypeEditEnd'],
  onIdChange: ShaderNodeData['onIdChange'],
  onPortDoubleClick: ShaderNodeData['onPortDoubleClick'],
  onPortNameChange: ShaderNodeData['onPortNameChange'],
  onPortMove: ShaderNodeData['onPortMove'],
  editingTypeNodeId: string | null,
): ShaderFlowNode[] {
  return state.nodes.map((node) => ({
    id: node.id,
    type: 'shaderNode',
    position: node.position,
    data: {
      patchNode: {
        id: node.id,
        type: node.type,
        ...(node.subpatchName ? { subpatchName: node.subpatchName } : {}),
        ...(node.subpatchCloneId ? { subpatchCloneId: node.subpatchCloneId } : {}),
        ...(node.expression !== undefined ? { expression: node.expression } : {}),
        params: node.params,
        position: node.position,
        ...(node.inputs ? { inputs: node.inputs } : {}),
        ...(node.outputs ? { outputs: node.outputs } : {}),
        ...(node.subpatch ? { subpatch: node.subpatch } : {}),
      },
      onParamChange,
      onTypeChange,
      onTypeEditStart,
      onTypeEditEnd,
      onIdChange,
      onPortDoubleClick,
      onPortNameChange,
      onPortMove,
      isTypePickerOpen: editingTypeNodeId === node.id,
    },
  }));
}

export function editorStateToFlowEdges(
  state: PersistedEditorState,
  onWeightChange: ShaderEdgeData['onWeightChange'],
  onInsertNode: ShaderEdgeData['onInsertNode'] = noopInsertNode,
): ShaderFlowEdge[] {
  return state.edges.map((edge) => ({
    ...edge,
    type: 'shaderEdge',
    data: {
      weight: edge.weight ?? 1,
      mode: edge.mode ?? 'set',
      onWeightChange,
      onModeChange: noopModeChange,
      onInsertNode,
    },
    className: 'shader-edge',
  }));
}

function noopInsertNode() {
  // Replaced after React state exists.
}

function noopModeChange() {
  // Replaced after React state exists.
}

export function flowToEditorState(
  nodes: ShaderFlowNode[],
  edges: ShaderFlowEdge[],
  ui?: PersistedEditorState['ui'],
): PersistedEditorState {
  return {
    version: 1,
    ...(ui ? { ui } : {}),
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.data.patchNode.type,
      ...(node.data.patchNode.subpatchName ? { subpatchName: node.data.patchNode.subpatchName } : {}),
      ...(node.data.patchNode.subpatchCloneId ? { subpatchCloneId: node.data.patchNode.subpatchCloneId } : {}),
      ...(node.data.patchNode.expression !== undefined ? { expression: node.data.patchNode.expression } : {}),
      params: node.data.patchNode.params,
      position: node.position,
      ...(node.data.patchNode.inputs ? { inputs: node.data.patchNode.inputs } : {}),
      ...(node.data.patchNode.outputs ? { outputs: node.data.patchNode.outputs } : {}),
      ...(node.data.patchNode.subpatch ? { subpatch: node.data.patchNode.subpatch } : {}),
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      sourceHandle: edge.sourceHandle ?? null,
      target: edge.target,
      targetHandle: edge.targetHandle ?? null,
      weight: edge.data?.weight ?? 1,
      mode: edge.data?.mode ?? 'set',
    })),
  };
}

export function patchFromFlow(nodes: ShaderFlowNode[], edges: ShaderFlowEdge[]): Patch {
  const patchNodes: PatchNode[] = [];
  const typedNodeIds = new Set<string>();
  for (const node of nodes) {
    const patchNode = node.data.patchNode;
    if (patchNode.type === null) continue;
    typedNodeIds.add(patchNode.id);
    patchNodes.push({
      id: patchNode.id,
      type: patchNode.type,
      ...(patchNode.subpatchName ? { subpatchName: patchNode.subpatchName } : {}),
      ...(patchNode.subpatchCloneId ? { subpatchCloneId: patchNode.subpatchCloneId } : {}),
      ...(patchNode.expression !== undefined ? { expression: patchNode.expression } : {}),
      params: patchNode.params,
      position: node.position,
      ...(patchNode.inputs ? { inputs: patchNode.inputs } : {}),
      ...(patchNode.outputs ? { outputs: patchNode.outputs } : {}),
      ...(patchNode.subpatch ? { subpatch: patchNode.subpatch } : {}),
    });
  }

  return {
    nodes: patchNodes,
    links: edges
      .map(linkFromEdge)
      .filter((link): link is PatchLink => (
        link !== null &&
        typedNodeIds.has(link.from.node) &&
        typedNodeIds.has(link.to.node)
      )),
  };
}

export function linkFromEdge(edge: Edge): PatchLink | null {
  const sourcePort = parseHandle(edge.sourceHandle);
  const targetPort = parseHandle(edge.targetHandle);
  if (!sourcePort || !targetPort) return null;

  if (sourcePort.kind === 'out' && targetPort.kind === 'in') {
    return {
      from: { node: edge.source, port: sourcePort.port },
      to: { node: edge.target, port: targetPort.port },
      weight: edge.data?.weight as number | undefined,
      mode: edge.data?.mode as LinkMode | undefined,
    };
  }

  if (sourcePort.kind === 'in' && targetPort.kind === 'out') {
    return {
      from: { node: edge.target, port: targetPort.port },
      to: { node: edge.source, port: sourcePort.port },
      weight: edge.data?.weight as number | undefined,
      mode: edge.data?.mode as LinkMode | undefined,
    };
  }

  return null;
}

export function edgeId(link: PatchLink): string {
  return `${link.from.node}:${link.from.port}->${link.to.node}:${link.to.port}`;
}

function parseHandle(handle: string | null | undefined): { kind: 'in' | 'out'; port: string } | null {
  if (!handle) return null;
  const [kind, port] = handle.split(':');
  if ((kind !== 'in' && kind !== 'out') || !port) return null;
  return { kind, port };
}

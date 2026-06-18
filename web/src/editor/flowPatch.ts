import type { Edge, Node } from '@xyflow/react';
import type { NodeType, Patch, PatchLink, PatchNode } from '../graph/types';

export type EditorPatchNode = Omit<PatchNode, 'type'> & {
  type: NodeType | null;
};

export interface ShaderNodeData extends Record<string, unknown> {
  patchNode: EditorPatchNode;
  onParamChange: (nodeId: string, port: string, value: number) => void;
  onTypeChange: (nodeId: string, type: NodeType) => void;
  onTypeEditStart: (nodeId: string) => void;
  onTypeEditEnd: () => void;
  onIdChange: (nodeId: string, nextId: string) => void;
  onPortDoubleClick: (nodeId: string, side: 'input' | 'output', port: string) => void;
  isTypePickerOpen: boolean;
}

export type ShaderFlowNode = Node<ShaderNodeData, 'shaderNode'>;

export interface ShaderEdgeData extends Record<string, unknown> {
  weight: number;
  onWeightChange: (edgeId: string, weight: number) => void;
}

export type ShaderFlowEdge = Edge<ShaderEdgeData, 'shaderEdge'>;

export interface PersistedEditorState {
  version: 1;
  ui?: {
    sidePanelOpen?: boolean;
    viewport?: {
      x: number;
      y: number;
      zoom: number;
    };
  };
  nodes: Array<{
    id: string;
    type: NodeType | null;
    params: Record<string, number>;
    position: { x: number; y: number };
  }>;
  edges: Array<{
    id: string;
    source: string;
    sourceHandle: string | null;
    target: string;
    targetHandle: string | null;
    weight?: number;
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
      isTypePickerOpen: editingTypeNodeId === patchNode.id,
    },
  }));
}

export function toFlowEdges(
  patch: Patch,
  onWeightChange: ShaderEdgeData['onWeightChange'],
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
      onWeightChange,
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
        params: node.params,
        position: node.position,
      },
      onParamChange,
      onTypeChange,
      onTypeEditStart,
      onTypeEditEnd,
      onIdChange,
      onPortDoubleClick,
      isTypePickerOpen: editingTypeNodeId === node.id,
    },
  }));
}

export function editorStateToFlowEdges(
  state: PersistedEditorState,
  onWeightChange: ShaderEdgeData['onWeightChange'],
): ShaderFlowEdge[] {
  return state.edges.map((edge) => ({
    ...edge,
    type: 'shaderEdge',
    data: {
      weight: edge.weight ?? 1,
      onWeightChange,
    },
    className: 'shader-edge',
  }));
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
      params: node.data.patchNode.params,
      position: node.position,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      sourceHandle: edge.sourceHandle ?? null,
      target: edge.target,
      targetHandle: edge.targetHandle ?? null,
      weight: edge.data?.weight ?? 1,
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
      params: patchNode.params,
      position: node.position,
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
    };
  }

  if (sourcePort.kind === 'in' && targetPort.kind === 'out') {
    return {
      from: { node: edge.target, port: targetPort.port },
      to: { node: edge.source, port: sourcePort.port },
      weight: edge.data?.weight as number | undefined,
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

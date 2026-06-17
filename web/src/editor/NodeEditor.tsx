import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Connection,
  ConnectionMode,
  Controls,
  Edge,
  EdgeChange,
  MiniMap,
  NodeChange,
  ReactFlow,
  ReactFlowInstance,
  ReactFlowProvider,
  Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { compilePatchToGlsl } from '../graph/glsl';
import { defaultParamsFor, getDefinition } from '../graph/nodeTypes';
import { patchToJson } from '../graph/serialize';
import type { NodeType, Patch } from '../graph/types';
import { validatePatch } from '../graph/validate';
import { ExportPanel } from '../export/ExportPanel';
import { demoPatch } from '../graph/demoPatch';
import {
  edgeId,
  editorStateToFlowEdges,
  editorStateToFlowNodes,
  flowToEditorState,
  linkFromEdge,
  patchFromFlow,
  type PersistedEditorState,
  ShaderFlowNode,
  toFlowEdges,
  toFlowNodes,
} from './flowPatch';
import { makeNodeId, ShaderNode } from './ShaderNode';
import { WebGLPreview } from './WebGLPreview';

const nodeTypes = { shaderNode: ShaderNode };
const STORAGE_KEY = 'visual-visual.editor-state.v1';

export function NodeEditor() {
  return (
    <ReactFlowProvider>
      <NodeEditorInner />
    </ReactFlowProvider>
  );
}

function NodeEditorInner() {
  const [editingTypeNodeId, setEditingTypeNodeId] = useState<string | null>(null);
  const initialState = useMemo(() => loadInitialEditorState(), []);
  const [sidePanelOpen, setSidePanelOpen] = useState(initialState?.ui?.sidePanelOpen ?? true);
  const [viewport, setViewport] = useState<Viewport>(initialState?.ui?.viewport ?? { x: 0, y: 0, zoom: 1 });
  const [reactFlow, setReactFlow] = useState<ReactFlowInstance<ShaderFlowNode, Edge> | null>(null);
  const [nodes, setNodes] = useState<ShaderFlowNode[]>(() =>
    initialState
      ? editorStateToFlowNodes(
          initialState,
          updateParamPlaceholder,
          updateTypePlaceholder,
          updateTypeEditStartPlaceholder,
          updateTypeEditEndPlaceholder,
          null,
        )
      : toFlowNodes(
          demoPatch,
          updateParamPlaceholder,
          updateTypePlaceholder,
          updateTypeEditStartPlaceholder,
          updateTypeEditEndPlaceholder,
          null,
        ),
  );
  const [edges, setEdges] = useState<Edge[]>(() =>
    initialState ? editorStateToFlowEdges(initialState) : toFlowEdges(demoPatch),
  );

  const updateNodeParam = useCallback((nodeId: string, port: string, value: number) => {
    setNodes((current) =>
      current.map((node) =>
        node.id === nodeId
          ? {
              ...node,
              data: {
                ...node.data,
                patchNode: {
                  ...node.data.patchNode,
                  params: { ...node.data.patchNode.params, [port]: value },
                },
              },
            }
          : node,
      ),
    );
  }, []);

  const updateNodeType = useCallback((nodeId: string, type: NodeType) => {
    setNodes((current) =>
      current.map((node) => {
        if (node.id !== nodeId) return node;

        const previousType = node.data.patchNode.type;
        const previousInputs = previousType ? getDefinition(previousType).inputs : [];
        const nextInputs = getDefinition(type).inputs;
        const nextParams = defaultParamsFor(type);

        for (const [index, input] of nextInputs.entries()) {
          const previousInput = previousInputs[index];
          if (previousInput && node.data.patchNode.params[previousInput.name] !== undefined) {
            nextParams[input.name] = node.data.patchNode.params[previousInput.name];
          }
        }

        return {
          ...node,
          data: {
            ...node.data,
            patchNode: {
              ...node.data.patchNode,
              type,
              params: nextParams,
            },
          },
        };
      }),
    );
    setEdges((current) =>
      dedupeEdges(current.flatMap((edge) => {
        const relatedNode = nodes.find((node) => node.id === nodeId);
        if (!relatedNode) return [edge];
        const remapped = remapEdgeForNodeType(edge, nodeId, relatedNode.data.patchNode.type, type);
        return remapped ? [remapped] : [];
      })),
    );
  }, [nodes]);

  const nodesWithCallbacks = useMemo(
    () =>
      nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          onParamChange: updateNodeParam,
          onTypeChange: updateNodeType,
          onTypeEditStart: setEditingTypeNodeId,
          onTypeEditEnd: () => setEditingTypeNodeId(null),
          isTypePickerOpen: editingTypeNodeId === node.id,
        },
      })),
    [editingTypeNodeId, nodes, updateNodeParam, updateNodeType],
  );

  const patch = useMemo(() => patchFromFlow(nodesWithCallbacks, edges), [nodesWithCallbacks, edges]);
  const validation = useMemo(() => validatePatch(patch), [patch]);
  const compileResult = useMemo(() => compilePatchToGlsl(patch, 'webgl2'), [patch]);
  const json = useMemo(() => patchToJson(patch), [patch]);

  useEffect(() => {
    saveEditorState(nodesWithCallbacks, edges, {
      sidePanelOpen,
      viewport,
    });
  }, [edges, nodesWithCallbacks, sidePanelOpen, viewport]);

  const onNodesChange = useCallback((changes: NodeChange<ShaderFlowNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange<Edge>[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));
  }, []);

  const onConnect = useCallback((connection: Connection) => {
    const candidate: Edge = {
      id: `${connection.source}:${connection.sourceHandle}->${connection.target}:${connection.targetHandle}`,
      source: connection.source ?? '',
      sourceHandle: connection.sourceHandle,
      target: connection.target ?? '',
      targetHandle: connection.targetHandle,
      className: 'shader-edge',
    };
    const link = linkFromEdge(candidate);
    if (!link) return;

    setEdges((current) => {
      const alreadyConnected = current.some((edge) => {
        const existing = linkFromEdge(edge);
        return (
          existing &&
          existing.from.node === link.from.node &&
          existing.from.port === link.from.port &&
          existing.to.node === link.to.node &&
          existing.to.port === link.to.port
        );
      });
      if (alreadyConnected) return current;

      return addEdge(
        {
          ...candidate,
          id: edgeId(link),
          source: link.from.node,
          sourceHandle: `out:${link.from.port}`,
          target: link.to.node,
          targetHandle: `in:${link.to.port}`,
        },
        current,
      );
    });
  }, []);

  const addNodeAt = useCallback(
    (event: MouseEvent) => {
      if (!reactFlow) return;
      const existing = new Set(nodes.map((node) => node.id));
      const id = makeNodeId('node', existing);
      const position = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      setNodes((current) => [
        ...current,
        {
          id,
          type: 'shaderNode',
          position,
          data: {
            patchNode: {
              id,
              type: null,
              params: {},
              position,
            },
            onParamChange: updateNodeParam,
            onTypeChange: updateNodeType,
            onTypeEditStart: setEditingTypeNodeId,
            onTypeEditEnd: () => setEditingTypeNodeId(null),
            isTypePickerOpen: true,
          },
        },
      ]);
      setEditingTypeNodeId(id);
    },
    [nodes, reactFlow, updateNodeParam, updateNodeType],
  );

  const importPatch = useCallback((nextPatch: Patch) => {
    setEditingTypeNodeId(null);
    setNodes(
      toFlowNodes(
        nextPatch,
        updateNodeParam,
        updateNodeType,
        setEditingTypeNodeId,
        () => setEditingTypeNodeId(null),
        null,
      ),
    );
    setEdges(toFlowEdges(nextPatch));
  }, [updateNodeParam, updateNodeType]);

  return (
    <main className={sidePanelOpen ? 'app-shell' : 'app-shell app-shell-panel-closed'}>
      <section
        className="editor-shell"
        onDoubleClick={(event) => {
          const target = event.target as HTMLElement;
          if (target.classList.contains('react-flow__pane')) {
            event.preventDefault();
            event.stopPropagation();
            addNodeAt(event);
          }
        }}
      >
        <WebGLPreview fragmentShader={compileResult.shaderCode} />
        <button
          className="side-panel-toggle"
          type="button"
          onClick={() => setSidePanelOpen((open) => !open)}
          aria-label={sidePanelOpen ? 'Hide JSON and GLSL panel' : 'Show JSON and GLSL panel'}
          title={sidePanelOpen ? 'Hide panel' : 'Show panel'}
        >
          {sidePanelOpen ? '>' : '<'}
        </button>
        <ReactFlow
          nodes={nodesWithCallbacks}
          edges={edges}
          nodeTypes={nodeTypes}
          onInit={setReactFlow}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onMoveEnd={(_, nextViewport) => setViewport(nextViewport)}
          connectionMode={ConnectionMode.Loose}
          zoomOnDoubleClick={false}
          deleteKeyCode={['Backspace', 'Delete']}
          defaultViewport={initialState?.ui?.viewport}
          fitView={!initialState?.ui?.viewport}
        >
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </section>
      {sidePanelOpen ? (
        <ExportPanel
          json={json}
          shaderCode={compileResult.shaderCode}
          validation={validation}
          compileErrors={compileResult.errors}
          onImport={importPatch}
        />
      ) : null}
    </main>
  );
}

function updateParamPlaceholder() {
  // Replaced after React state exists.
}

function updateTypePlaceholder() {
  // Replaced after React state exists.
}

function updateTypeEditStartPlaceholder() {
  // Replaced after React state exists.
}

function updateTypeEditEndPlaceholder() {
  // Replaced after React state exists.
}

function remapEdgeForNodeType(
  edge: Edge,
  nodeId: string,
  previousType: NodeType | null,
  nextType: NodeType,
): Edge | null {
  const link = linkFromEdge(edge);
  if (!link) return null;
  if (link.from.node !== nodeId && link.to.node !== nodeId) return edge;
  if (!previousType) return null;

  let nextLink = link;

  if (link.from.node === nodeId) {
    const nextPort = remapPortByIndex(
      getDefinition(previousType).outputs.map((port) => port.name),
      getDefinition(nextType).outputs.map((port) => port.name),
      link.from.port,
    );
    if (!nextPort) return null;
    nextLink = {
      ...nextLink,
      from: { ...nextLink.from, port: nextPort },
    };
  }

  if (link.to.node === nodeId) {
    const nextPort = remapPortByIndex(
      getDefinition(previousType).inputs.map((port) => port.name),
      getDefinition(nextType).inputs.map((port) => port.name),
      link.to.port,
    );
    if (!nextPort) return null;
    nextLink = {
      ...nextLink,
      to: { ...nextLink.to, port: nextPort },
    };
  }

  return {
    ...edge,
    id: edgeId(nextLink),
    source: nextLink.from.node,
    sourceHandle: `out:${nextLink.from.port}`,
    target: nextLink.to.node,
    targetHandle: `in:${nextLink.to.port}`,
  };
}

function remapPortByIndex(previousPorts: string[], nextPorts: string[], previousPort: string): string | null {
  const index = previousPorts.indexOf(previousPort);
  if (index === -1) return null;
  return nextPorts[index] ?? null;
}

function dedupeEdges(edges: Edge[]): Edge[] {
  const seen = new Set<string>();
  const deduped: Edge[] = [];

  for (const edge of edges) {
    const link = linkFromEdge(edge);
    if (!link) continue;

    const key = edgeId(link);
    if (seen.has(key)) continue;

    seen.add(key);
    deduped.push({ ...edge, id: key });
  }

  return deduped;
}

function loadInitialEditorState(): PersistedEditorState | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedEditorState;
    if (parsed.version !== 1 || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveEditorState(
  nodes: ShaderFlowNode[],
  edges: Edge[],
  ui?: PersistedEditorState['ui'],
): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(flowToEditorState(nodes, edges, ui)));
  } catch {
    // Local storage can be unavailable in private or restricted browsing contexts.
  }
}

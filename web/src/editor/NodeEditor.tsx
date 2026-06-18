import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Connection,
  ConnectionMode,
  Controls,
  EdgeChange,
  MiniMap,
  NodeChange,
  ReactFlow,
  ReactFlowInstance,
  ReactFlowProvider,
  SelectionMode,
  Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { compilePatchToGlsl } from '../graph/glsl';
import { acceptsInputLink, defaultParamsFor, getDefinition, NODE_TYPE_LIST } from '../graph/nodeTypes';
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
  ShaderFlowEdge,
  ShaderFlowNode,
  toFlowEdges,
  toFlowNodes,
} from './flowPatch';
import { ShaderEdge } from './ShaderEdge';
import { makeNodeId, ShaderNode } from './ShaderNode';
import { WebGLPreview } from './WebGLPreview';

const nodeTypes = { shaderNode: ShaderNode };
const edgeTypes = { shaderEdge: ShaderEdge };
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
  const [exportPanelView, setExportPanelView] = useState<'glsl' | 'json'>(
    initialState?.ui?.exportPanelView === 'json' ? 'json' : 'glsl',
  );
  const [importError, setImportError] = useState<string | null>(null);
  const [uiHidden, setUiHidden] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [viewport, setViewport] = useState<Viewport>(initialState?.ui?.viewport ?? { x: 0, y: 0, zoom: 1 });
  const [fps, setFps] = useState(0);
  const [reactFlow, setReactFlow] = useState<ReactFlowInstance<ShaderFlowNode, ShaderFlowEdge> | null>(null);
  const [nodes, setNodes] = useState<ShaderFlowNode[]>(() =>
    initialState
      ? editorStateToFlowNodes(
          initialState,
          updateParamPlaceholder,
          updateTypePlaceholder,
          updateTypeEditStartPlaceholder,
          updateTypeEditEndPlaceholder,
          updateIdPlaceholder,
          portDoubleClickPlaceholder,
          null,
        )
      : toFlowNodes(
          demoPatch,
          updateParamPlaceholder,
          updateTypePlaceholder,
          updateTypeEditStartPlaceholder,
          updateTypeEditEndPlaceholder,
          updateIdPlaceholder,
          portDoubleClickPlaceholder,
          null,
        ),
  );
  const [edges, setEdges] = useState<ShaderFlowEdge[]>(() =>
    initialState ? editorStateToFlowEdges(initialState, updateEdgeWeightPlaceholder) : toFlowEdges(demoPatch, updateEdgeWeightPlaceholder),
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

  const updateEdgeWeight = useCallback((edgeIdToUpdate: string, weight: number) => {
    setEdges((current) =>
      current.map((edge) =>
        edge.id === edgeIdToUpdate
          ? {
              ...edge,
              data: {
                ...edge.data,
                weight,
                onWeightChange: edge.data?.onWeightChange ?? updateEdgeWeightPlaceholder,
              },
            }
          : edge,
      ),
    );
  }, []);

  const updateNodeId = useCallback((nodeId: string, requestedId: string) => {
    const nextId = uniqueNodeId(requestedId, nodeId, nodes);
    if (!nextId || nextId === nodeId) return;

    setNodes((current) =>
      current.map((node) =>
        node.id === nodeId
          ? {
              ...node,
              id: nextId,
              data: {
                ...node.data,
                patchNode: {
                  ...node.data.patchNode,
                  id: nextId,
                },
              },
            }
          : node,
      ),
    );
    setEdges((current) => dedupeEdges(current.map((edge) => renameEdgeNode(edge, nodeId, nextId))));
    setEditingTypeNodeId((current) => current === nodeId ? nextId : current);
  }, [nodes]);

  const updateNodeType = useCallback((nodeId: string, type: NodeType) => {
    const relatedNode = nodes.find((node) => node.id === nodeId);
    if (!relatedNode) return;

    const previousType = relatedNode.data.patchNode.type;
    const nextId = shouldAutoRenameForTypeChange(nodeId, previousType)
      ? nextTypeNodeId(nodeId, type, nodes)
      : nodeId;

    setNodes((current) =>
      current.map((node) => {
        if (node.id !== nodeId) return node;

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
          id: nextId,
          data: {
            ...node.data,
            patchNode: {
              ...node.data.patchNode,
              id: nextId,
              type,
              params: nextParams,
            },
          },
        };
      }),
    );
    setEdges((current) =>
      dedupeEdges(current.flatMap((edge) => {
        const renamedEdge = renameEdgeNode(edge, nodeId, nextId);
        const remapped = remapEdgeForNodeType(renamedEdge, nextId, previousType, type);
        return remapped ? [remapped] : [];
      })),
    );
    setEditingTypeNodeId((current) => current === nodeId ? nextId : current);
  }, [nodes]);

  const insertNodeOnPort = useCallback((nodeId: string, side: 'input' | 'output', port: string) => {
    const relatedEdges = edges
      .map((edge) => ({ edge, link: linkFromEdge(edge) }))
      .filter(({ link }) => {
        if (!link) return false;
        return side === 'output'
          ? link.from.node === nodeId && link.from.port === port
          : link.to.node === nodeId && link.to.port === port;
      });

    if (relatedEdges.length === 0) return;

    const existingIds = new Set(nodes.map((node) => node.id));
    const id = makeNodeId('node', existingIds);
    const firstLink = relatedEdges[0].link;
    const sourceNode = firstLink ? nodes.find((node) => node.id === firstLink.from.node) : null;
    const targetNode = firstLink ? nodes.find((node) => node.id === firstLink.to.node) : null;
    const position = midpointPosition(sourceNode?.position, targetNode?.position);

    const insertedNode: ShaderFlowNode = {
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
        onIdChange: updateNodeId,
        onPortDoubleClick: portDoubleClickPlaceholder,
        isTypePickerOpen: true,
      },
    };

    const relatedEdgeIds = new Set(relatedEdges.map(({ edge }) => edge.id));
    const rewiredEdges = edges.flatMap((edge) => {
      if (!relatedEdgeIds.has(edge.id)) return [edge];

      const link = linkFromEdge(edge);
      if (!link) return [];

      return [
        edgeFromLink({
          from: link.from,
          to: { node: id, port: 'value' },
        }),
        edgeFromLink({
          from: { node: id, port: 'value' },
          to: link.to,
          weight: link.weight,
        }),
      ];
    });

    setNodes((current) => [...current, insertedNode]);
    setEdges(dedupeEdges(rewiredEdges));
    setEditingTypeNodeId(id);
  }, [edges, nodes, updateNodeParam, updateNodeType]);

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
          onIdChange: updateNodeId,
          onPortDoubleClick: insertNodeOnPort,
          isTypePickerOpen: editingTypeNodeId === node.id,
        },
      })),
    [editingTypeNodeId, insertNodeOnPort, nodes, updateNodeId, updateNodeParam, updateNodeType],
  );

  const edgesWithCallbacks = useMemo(
    () =>
      edges.map((edge) => ({
        ...edge,
        data: {
          ...edge.data,
          weight: edge.data?.weight ?? 1,
          onWeightChange: updateEdgeWeight,
        },
      })),
    [edges, updateEdgeWeight],
  );

  const patch = useMemo(() => patchFromFlow(nodesWithCallbacks, edgesWithCallbacks), [nodesWithCallbacks, edgesWithCallbacks]);
  const patchJson = useMemo(() => patchToJson(patch), [patch]);
  const validation = useMemo(() => validatePatch(patch), [patch]);
  const compileResult = useMemo(() => compilePatchToGlsl(patch, 'webgl2'), [patch]);
  const feedbackEdgeIds = useMemo(() => new Set(compileResult.feedbackLinkIds), [compileResult.feedbackLinkIds]);
  const displayEdges = useMemo(() => {
    return edgesWithCallbacks.map((edge) => {
      const link = linkFromEdge(edge);
      const className = link && feedbackEdgeIds.has(edgeId(link))
        ? 'shader-edge shader-edge-feedback'
        : 'shader-edge';

      return edge.className === className ? edge : { ...edge, className };
    });
  }, [edgesWithCallbacks, feedbackEdgeIds]);
  useEffect(() => {
    saveEditorState(nodesWithCallbacks, edgesWithCallbacks, {
      sidePanelOpen,
      exportPanelView,
      viewport,
    });
  }, [edgesWithCallbacks, exportPanelView, nodesWithCallbacks, sidePanelOpen, viewport]);

  useEffect(() => {
    const updateFullscreenState = () => {
      setIsFullscreen(document.fullscreenElement !== null);
    };

    document.addEventListener('fullscreenchange', updateFullscreenState);
    updateFullscreenState();

    return () => {
      document.removeEventListener('fullscreenchange', updateFullscreenState);
    };
  }, []);

  const onNodesChange = useCallback((changes: NodeChange<ShaderFlowNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange<ShaderFlowEdge>[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));
  }, []);

  const onConnect = useCallback((connection: Connection) => {
    const candidate: ShaderFlowEdge = {
      id: `${connection.source}:${connection.sourceHandle}->${connection.target}:${connection.targetHandle}`,
      type: 'shaderEdge',
      source: connection.source ?? '',
      sourceHandle: connection.sourceHandle,
      target: connection.target ?? '',
      targetHandle: connection.targetHandle,
      data: {
        weight: 1,
        onWeightChange: updateEdgeWeight,
      },
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
          data: {
            weight: 1,
            onWeightChange: updateEdgeWeight,
          },
        },
        current,
      );
    });
  }, [updateEdgeWeight]);

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
            onIdChange: updateNodeId,
            onPortDoubleClick: insertNodeOnPort,
            isTypePickerOpen: true,
          },
        },
      ]);
      setEditingTypeNodeId(id);
    },
    [insertNodeOnPort, nodes, reactFlow, updateNodeId, updateNodeParam, updateNodeType],
  );

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }

    void document.documentElement.requestFullscreen();
  }, []);

  const loadPatchJson = useCallback((json: string) => {
    let loadedPatch: Patch;

    try {
      loadedPatch = parsePatchJson(json);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
      return;
    }

    const loadedValidation = validatePatch(loadedPatch);
    if (!loadedValidation.ok) {
      setImportError(loadedValidation.errors.join('\n'));
      return;
    }

    setNodes(toFlowNodes(
      loadedPatch,
      updateNodeParam,
      updateNodeType,
      setEditingTypeNodeId,
      () => setEditingTypeNodeId(null),
      updateNodeId,
      insertNodeOnPort,
      null,
    ));
    setEdges(toFlowEdges(loadedPatch, updateEdgeWeight));
    setEditingTypeNodeId(null);
    setImportError(null);
    setExportPanelView('json');
  }, [insertNodeOnPort, updateEdgeWeight, updateNodeId, updateNodeParam, updateNodeType]);

  const shellClassName = [
    'app-shell',
    sidePanelOpen && !uiHidden ? '' : 'app-shell-panel-closed',
    uiHidden ? 'app-shell-ui-hidden' : '',
  ].filter(Boolean).join(' ');

  return (
    <main className={shellClassName}>
      <WebGLPreview
        fragmentShader={compileResult.shaderCode}
        feedbackTextureCount={compileResult.feedbackTextureCount}
        shaderArgs={compileResult.shaderArgs}
        delaySlots={compileResult.delaySlots}
        envelopeSlots={compileResult.envelopeSlots}
        mediaRequirements={compileResult.media}
        onFpsChange={setFps}
      />
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
        <div className="viewport-buttons">
          <button
            className="viewport-button side-panel-toggle"
            type="button"
            onClick={() => setSidePanelOpen((open) => !open)}
            aria-label={sidePanelOpen ? 'Hide export panel' : 'Show export panel'}
            title={sidePanelOpen ? 'Hide panel' : 'Show panel'}
          >
            {sidePanelOpen ? '>' : '<'}
          </button>
          <button
            className="viewport-button"
            type="button"
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            FS
          </button>
          <button
            className="viewport-button viewport-button-ui"
            type="button"
            onClick={() => setUiHidden((hidden) => !hidden)}
            aria-label={uiHidden ? 'Show UI' : 'Hide UI'}
            title={uiHidden ? 'Show UI' : 'Hide UI'}
          >
            {uiHidden ? 'SHOW' : 'UI'}
          </button>
        </div>
        <div className="fps-counter">{fps} fps</div>
        <ReactFlow
          nodes={nodesWithCallbacks}
          edges={displayEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onInit={setReactFlow}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onMoveEnd={(_, nextViewport) => setViewport(nextViewport)}
          connectionMode={ConnectionMode.Loose}
          panOnScroll
          panOnDrag={false}
          zoomOnScroll={false}
          zoomOnPinch
          zoomOnDoubleClick={false}
          selectionOnDrag
          selectionMode={SelectionMode.Partial}
          selectionKeyCode={null}
          panActivationKeyCode={null}
          deleteKeyCode={['Backspace', 'Delete']}
          defaultViewport={initialState?.ui?.viewport}
          fitView={!initialState?.ui?.viewport}
        >
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </section>
      {sidePanelOpen && !uiHidden ? (
        <ExportPanel
          patchJson={patchJson}
          shaderCode={compileResult.shaderCode}
          validation={validation}
          compileErrors={compileResult.errors}
          activeView={exportPanelView}
          onActiveViewChange={setExportPanelView}
          onLoadJson={loadPatchJson}
          importError={importError}
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

function updateIdPlaceholder() {
  // Replaced after React state exists.
}

function updateEdgeWeightPlaceholder() {
  // Replaced after React state exists.
}

function portDoubleClickPlaceholder() {
  // Replaced after React state exists.
}

function edgeFromLink(link: NonNullable<ReturnType<typeof linkFromEdge>>): ShaderFlowEdge {
  return {
    id: edgeId(link),
    type: 'shaderEdge',
    source: link.from.node,
    sourceHandle: `out:${link.from.port}`,
    target: link.to.node,
    targetHandle: `in:${link.to.port}`,
    data: {
      weight: link.weight ?? 1,
      onWeightChange: updateEdgeWeightPlaceholder,
    },
    className: 'shader-edge',
  };
}

function renameEdgeNode(edge: ShaderFlowEdge, previousNodeId: string, nextNodeId: string): ShaderFlowEdge {
  if (previousNodeId === nextNodeId) return edge;

  return {
    ...edge,
    source: edge.source === previousNodeId ? nextNodeId : edge.source,
    target: edge.target === previousNodeId ? nextNodeId : edge.target,
  };
}

function nextTypeNodeId(currentNodeId: string, type: NodeType, nodes: ShaderFlowNode[]): string {
  const prefix = type.toLowerCase();
  if (currentNodeId.startsWith(`${prefix}_`)) {
    return currentNodeId;
  }

  const existingIds = new Set(nodes.map((node) => node.id));
  existingIds.delete(currentNodeId);
  return makeNodeId(type, existingIds);
}

function shouldAutoRenameForTypeChange(nodeId: string, previousType: NodeType | null): boolean {
  return isGeneratedNodeId(nodeId, previousType);
}

function isGeneratedNodeId(nodeId: string, type: NodeType | null): boolean {
  const prefix = type ? type.toLowerCase() : 'node';
  return new RegExp(`^${escapeRegExp(prefix)}_[0-9]+$`).test(nodeId);
}

function uniqueNodeId(requestedId: string, currentNodeId: string, nodes: ShaderFlowNode[]): string | null {
  const normalized = normalizeNodeId(requestedId);
  if (!normalized) return null;
  if (normalized === currentNodeId) return currentNodeId;

  const existingIds = new Set(nodes.map((node) => node.id));
  existingIds.delete(currentNodeId);
  if (!existingIds.has(normalized)) return normalized;

  let index = 2;
  let candidate = `${normalized}_${index}`;
  while (existingIds.has(candidate)) {
    index += 1;
    candidate = `${normalized}_${index}`;
  }
  return candidate;
}

function normalizeNodeId(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[-_]+|[-_]+$/g, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function midpointPosition(
  sourcePosition: { x: number; y: number } | undefined,
  targetPosition: { x: number; y: number } | undefined,
): { x: number; y: number } {
  if (sourcePosition && targetPosition) {
    return {
      x: (sourcePosition.x + targetPosition.x) / 2,
      y: (sourcePosition.y + targetPosition.y) / 2,
    };
  }

  if (sourcePosition) {
    return { x: sourcePosition.x + 220, y: sourcePosition.y };
  }

  if (targetPosition) {
    return { x: targetPosition.x - 220, y: targetPosition.y };
  }

  return { x: 0, y: 0 };
}

function remapEdgeForNodeType(
  edge: ShaderFlowEdge,
  nodeId: string,
  previousType: NodeType | null,
  nextType: NodeType,
): ShaderFlowEdge | null {
  const link = linkFromEdge(edge);
  if (!link) return null;
  if (link.from.node !== nodeId && link.to.node !== nodeId) return edge;

  if (!previousType) {
    let nextLink = link;

    if (link.from.node === nodeId) {
      const nextPort = getDefinition(nextType).outputs[0]?.name;
      if (!nextPort) return null;
      nextLink = {
        ...nextLink,
        from: { ...nextLink.from, port: nextPort },
      };
    }

    if (link.to.node === nodeId) {
      const nextPort = getDefinition(nextType).inputs.find((input) => input.connectable !== false)?.name;
      if (!nextPort) return null;
      nextLink = {
        ...nextLink,
        to: { ...nextLink.to, port: nextPort },
      };
    }

    return edgeFromLink(nextLink);
  }

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
    if (!nextPort || !acceptsInputLink(nextType, nextPort)) return null;
    nextLink = {
      ...nextLink,
      to: { ...nextLink.to, port: nextPort },
    };
  }

  return edgeFromLink(nextLink);
}

function remapPortByIndex(previousPorts: string[], nextPorts: string[], previousPort: string): string | null {
  const index = previousPorts.indexOf(previousPort);
  if (index === -1) return null;
  return nextPorts[index] ?? null;
}

function dedupeEdges(edges: ShaderFlowEdge[]): ShaderFlowEdge[] {
  const seen = new Set<string>();
  const deduped: ShaderFlowEdge[] = [];

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
  edges: ShaderFlowEdge[],
  ui?: PersistedEditorState['ui'],
): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(flowToEditorState(nodes, edges, ui)));
  } catch {
    // Local storage can be unavailable in private or restricted browsing contexts.
  }
}

function parsePatchJson(json: string): Patch {
  const parsed = JSON.parse(json) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('Patch JSON must be an object.');
  }
  if (!Array.isArray(parsed.nodes)) {
    throw new Error('Patch JSON must contain a nodes array.');
  }
  if (!Array.isArray(parsed.links)) {
    throw new Error('Patch JSON must contain a links array.');
  }

  return {
    nodes: parsed.nodes.map((node, index) => parsePatchNode(node, index)),
    links: parsed.links.map((link, index) => parsePatchLink(link, index)),
  };
}

function parsePatchNode(value: unknown, index: number): Patch['nodes'][number] {
  if (!isRecord(value)) {
    throw new Error(`Node ${index} must be an object.`);
  }
  if (typeof value.id !== 'string' || value.id.trim() === '') {
    throw new Error(`Node ${index} needs a string id.`);
  }
  if (!isNodeType(value.type)) {
    throw new Error(`Node "${value.id}" has an unknown type.`);
  }
  if (!isNumberRecord(value.params)) {
    throw new Error(`Node "${value.id}" needs numeric params.`);
  }

  const position = value.position === undefined ? undefined : parsePosition(value.position, value.id);
  return {
    id: value.id,
    type: value.type,
    params: value.params,
    ...(position ? { position } : {}),
  };
}

function parsePatchLink(value: unknown, index: number): Patch['links'][number] {
  if (!isRecord(value)) {
    throw new Error(`Link ${index} must be an object.`);
  }

  const from = parseEndpoint(value.from, `Link ${index} source`);
  const to = parseEndpoint(value.to, `Link ${index} target`);
  const weight = value.weight;
  if (weight !== undefined && (typeof weight !== 'number' || !Number.isFinite(weight))) {
    throw new Error(`Link ${index} weight must be numeric.`);
  }

  return {
    from,
    to,
    ...(weight === undefined ? {} : { weight }),
  };
}

function parseEndpoint(value: unknown, label: string): Patch['links'][number]['from'] {
  if (!isRecord(value) || typeof value.node !== 'string' || typeof value.port !== 'string') {
    throw new Error(`${label} must contain string node and port values.`);
  }

  return {
    node: value.node,
    port: value.port,
  };
}

function parsePosition(value: unknown, nodeId: string): Patch['nodes'][number]['position'] {
  if (
    !isRecord(value) ||
    typeof value.x !== 'number' ||
    typeof value.y !== 'number' ||
    !Number.isFinite(value.x) ||
    !Number.isFinite(value.y)
  ) {
    throw new Error(`Node "${nodeId}" position must contain numeric x and y values.`);
  }

  return {
    x: value.x,
    y: value.y,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === 'number' && Number.isFinite(entry));
}

function isNodeType(value: unknown): value is NodeType {
  return typeof value === 'string' && (NODE_TYPE_LIST as string[]).includes(value);
}

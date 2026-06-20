import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Connection,
  ConnectionMode,
  Controls,
  EdgeChange,
  HandleType,
  MiniMap,
  NodeChange,
  OnConnectEnd,
  OnConnectStartParams,
  ReactFlow,
  ReactFlowInstance,
  ReactFlowProvider,
  SelectionMode,
  Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent, type MutableRefObject } from 'react';
import { compilePatchToGlsl } from '../graph/glsl';
import { acceptsInputLink, defaultParamsFor, getDefinition, NODE_TYPE_LIST } from '../graph/nodeTypes';
import { patchToJson } from '../graph/serialize';
import type { LinkMode, NodeType, Patch, PatchLink } from '../graph/types';
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
import { EdgeOverlayProvider } from './EdgeOverlayContext';
import { ShaderEdge } from './ShaderEdge';
import { makeNodeId, ShaderNode } from './ShaderNode';
import { WebGLPreview, type WebGLPreviewHandle } from './WebGLPreview';

const nodeTypes = { shaderNode: ShaderNode };
const edgeTypes = { shaderEdge: ShaderEdge };
const STORAGE_KEY = 'visual-visual.editor-state.v1';
const HISTORY_LIMIT = 100;
const DRAFT_NODE_PREVIEW_ID = '__draft_node_preview__';
const DUPLICATE_NODE_PREVIEW_PREFIX = '__duplicate_node_preview__:';
const PASTE_OFFSET = { x: 36, y: 36 };
const DRAFT_NODE_WIDTH = 168;
const DRAFT_NODE_HANDLE_X_OFFSET = 13;
const DRAFT_NODE_FIRST_PORT_Y = 52;

type GraphSnapshot = Pick<PersistedEditorState, 'nodes' | 'edges'>;

interface DraftNodeConnection {
  originNodeId: string;
  originHandleId: string;
  originHandleType: HandleType;
  pointer: { x: number; y: number };
  modifierActive: boolean;
}

interface CopiedGraph {
  nodes: ShaderFlowNode[];
  edges: ShaderFlowEdge[];
  boundaryEdges: ShaderFlowEdge[];
}

interface DuplicateDragState extends CopiedGraph {
  currentPositions: Record<string, { x: number; y: number }>;
  duplicating: boolean;
  linkExternal: boolean;
}

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
  const [importError, setImportError] = useState<string | null>(null);
  const [uiHidden, setUiHidden] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [viewport, setViewport] = useState<Viewport>(initialState?.ui?.viewport ?? { x: 0, y: 0, zoom: 1 });
  const [fps, setFps] = useState(0);
  const [reactFlow, setReactFlow] = useState<ReactFlowInstance<ShaderFlowNode, ShaderFlowEdge> | null>(null);
  const [edgeOverlayElement, setEdgeOverlayElement] = useState<HTMLElement | null>(null);
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
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const copiedGraphRef = useRef<CopiedGraph | null>(null);
  const pasteCountRef = useRef(0);
  const draftNodeConnectionRef = useRef<DraftNodeConnection | null>(null);
  const duplicateDragRef = useRef<DuplicateDragState | null>(null);
  const historyGroupRef = useRef<{ key: string; time: number } | null>(null);
  const nodeDragHistoryRef = useRef(false);
  const [history, setHistory] = useState<{ past: GraphSnapshot[]; future: GraphSnapshot[] }>({
    past: [],
    future: [],
  });
  const [draftNodeConnection, setDraftNodeConnection] = useState<DraftNodeConnection | null>(null);
  const [duplicateDrag, setDuplicateDrag] = useState<DuplicateDragState | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const editorShellRef = useRef<HTMLElement | null>(null);
  const previewRef = useRef<WebGLPreviewHandle | null>(null);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

  const updateDraftNodeConnection = useCallback((
    value: DraftNodeConnection | null | ((current: DraftNodeConnection | null) => DraftNodeConnection | null),
  ) => {
    setDraftNodeConnection((current) => {
      const next = typeof value === 'function' ? value(current) : value;
      draftNodeConnectionRef.current = next;
      return next;
    });
  }, []);

  const updateDuplicateDrag = useCallback((
    value: DuplicateDragState | null | ((current: DuplicateDragState | null) => DuplicateDragState | null),
  ) => {
    setDuplicateDrag((current) => {
      const next = typeof value === 'function' ? value(current) : value;
      duplicateDragRef.current = next;
      return next;
    });
  }, []);

  const commitHistory = useCallback((groupKey?: string) => {
    const now = Date.now();
    const lastGroup = historyGroupRef.current;
    if (groupKey && lastGroup?.key === groupKey && now - lastGroup.time < 800) {
      historyGroupRef.current = { key: groupKey, time: now };
      return;
    }

    const snapshot = graphSnapshot(nodesRef.current, edgesRef.current);
    const snapshotKey = graphSnapshotKey(snapshot);

    setHistory((current) => {
      const lastSnapshot = current.past[current.past.length - 1];
      if (lastSnapshot && graphSnapshotKey(lastSnapshot) === snapshotKey) {
        return current;
      }

      return {
        past: [...current.past, snapshot].slice(-HISTORY_LIMIT),
        future: [],
      };
    });
    historyGroupRef.current = groupKey ? { key: groupKey, time: now } : null;
  }, []);

  const updateNodeParam = useCallback((nodeId: string, port: string, value: number) => {
    commitHistory(`param:${nodeId}:${port}`);
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
  }, [commitHistory]);

  const updateEdgeWeight = useCallback((edgeIdToUpdate: string, weight: number) => {
    commitHistory(`weight:${edgeIdToUpdate}`);
    setEdges((current) =>
      current.map((edge) =>
        edge.id === edgeIdToUpdate
          ? {
              ...edge,
              data: {
                ...edge.data,
                weight,
                mode: edge.data?.mode ?? 'set',
                onWeightChange: edge.data?.onWeightChange ?? updateEdgeWeightPlaceholder,
                onModeChange: edge.data?.onModeChange ?? updateEdgeModePlaceholder,
                onInsertNode: edge.data?.onInsertNode ?? updateEdgeInsertPlaceholder,
              },
            }
          : edge,
      ),
    );
  }, [commitHistory]);

  const updateEdgeMode = useCallback((edgeIdToUpdate: string, mode: LinkMode) => {
    commitHistory(`mode:${edgeIdToUpdate}`);
    setEdges((current) =>
      current.map((edge) =>
        edge.id === edgeIdToUpdate
          ? {
              ...edge,
              data: {
                ...edge.data,
                weight: edge.data?.weight ?? 1,
                mode,
                onWeightChange: edge.data?.onWeightChange ?? updateEdgeWeightPlaceholder,
                onModeChange: edge.data?.onModeChange ?? updateEdgeModePlaceholder,
                onInsertNode: edge.data?.onInsertNode ?? updateEdgeInsertPlaceholder,
              },
            }
          : edge,
      ),
    );
  }, [commitHistory]);

  const updateNodeId = useCallback((nodeId: string, requestedId: string) => {
    const nextId = uniqueNodeId(requestedId, nodeId, nodes);
    if (!nextId || nextId === nodeId) return;

    commitHistory();
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
  }, [commitHistory, nodes]);

  const updateNodeType = useCallback((nodeId: string, type: NodeType) => {
    const relatedNode = nodes.find((node) => node.id === nodeId);
    if (!relatedNode) return;

    const previousType = relatedNode.data.patchNode.type;
    const nextId = shouldAutoRenameForTypeChange(nodeId, previousType)
      ? nextTypeNodeId(nodeId, type, nodes)
      : nodeId;

    commitHistory();
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
  }, [commitHistory, nodes]);

  const insertNodeOnEdges = useCallback((relatedEdges: ShaderFlowEdge[]) => {
    if (relatedEdges.length === 0) return;

    commitHistory();
    const existingIds = new Set(nodes.map((node) => node.id));
    const id = makeNodeId('node', existingIds);
    const firstLink = linkFromEdge(relatedEdges[0]);
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

    const relatedEdgeIds = new Set(relatedEdges.map((edge) => edge.id));
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
          mode: link.mode,
        }),
      ];
    });

    setNodes((current) => [...current, insertedNode]);
    setEdges(dedupeEdges(rewiredEdges));
    setEditingTypeNodeId(id);
  }, [commitHistory, edges, nodes, updateNodeId, updateNodeParam, updateNodeType]);

  const insertNodeOnPort = useCallback((nodeId: string, side: 'input' | 'output', port: string) => {
    const relatedEdges = edges
      .map((edge) => ({ edge, link: linkFromEdge(edge) }))
      .filter(({ link }) => {
        if (!link) return false;
        return side === 'output'
          ? link.from.node === nodeId && link.from.port === port
          : link.to.node === nodeId && link.to.port === port;
      });

    insertNodeOnEdges(relatedEdges.map(({ edge }) => edge));
  }, [edges, insertNodeOnEdges]);

  const insertNodeOnEdge = useCallback((edgeIdToInsert: string) => {
    const edge = edges.find((candidate) => candidate.id === edgeIdToInsert);
    if (!edge) return;
    insertNodeOnEdges([edge]);
  }, [edges, insertNodeOnEdges]);

  const createDraftNodeFromConnection = useCallback(() => {
    const draftConnection = draftNodeConnectionRef.current;
    if (!draftConnection || !draftConnection.modifierActive || !reactFlow) return;

    const existingIds = new Set(nodesRef.current.map((node) => node.id));
    const id = makeNodeId('node', existingIds);
    const position = draftNodePosition(draftConnection, reactFlow);
    const link = linkForDraftNodeConnection(draftConnection, id);
    if (!link) return;

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

    commitHistory();
    setNodes((current) => [...current, insertedNode]);
    setEdges((current) => dedupeEdges([...current, edgeFromLink(link)]));
    setEditingTypeNodeId(id);
  }, [commitHistory, reactFlow, updateNodeId, updateNodeParam, updateNodeType]);

  const onConnectStart = useCallback((event: globalThis.MouseEvent | TouchEvent, params: OnConnectStartParams) => {
    const pointer = clientPointFromEvent(event);
    if (!pointer || !params.nodeId || !params.handleId || !params.handleType) {
      updateDraftNodeConnection(null);
      return;
    }

    updateDraftNodeConnection({
      originNodeId: params.nodeId,
      originHandleId: params.handleId,
      originHandleType: params.handleType,
      pointer,
      modifierActive: isCommandModifierPressed(event),
    });
  }, [updateDraftNodeConnection]);

  const onConnectEnd = useCallback<OnConnectEnd>((event, connectionState) => {
    const pointer = clientPointFromEvent(event);
    if (pointer && draftNodeConnectionRef.current) {
      draftNodeConnectionRef.current = {
        ...draftNodeConnectionRef.current,
        pointer,
        modifierActive: draftNodeConnectionRef.current.modifierActive || isCommandModifierPressed(event),
      };
    }

    if (!connectionState.toHandle || connectionState.toHandle.nodeId === DRAFT_NODE_PREVIEW_ID) {
      createDraftNodeFromConnection();
    }
    updateDraftNodeConnection(null);
  }, [createDraftNodeFromConnection, updateDraftNodeConnection]);

  const deleteSelectedNodesWithBridge = useCallback(() => {
    const selectedNodeIds = new Set(
      nodesRef.current
        .filter((node) => node.selected)
        .map((node) => node.id),
    );
    if (selectedNodeIds.size === 0) return false;

    const bridgeEdges = buildBridgeEdges(nodesRef.current, edgesRef.current, selectedNodeIds);
    const remainingEdges = edgesRef.current.filter((edge) => {
      const link = linkFromEdge(edge);
      return link && !selectedNodeIds.has(link.from.node) && !selectedNodeIds.has(link.to.node);
    });

    commitHistory();
    setNodes((current) => current.filter((node) => !selectedNodeIds.has(node.id)));
    setEdges(dedupeEdges([...remainingEdges, ...bridgeEdges]));
    setEditingTypeNodeId((current) => current && selectedNodeIds.has(current) ? null : current);

    return true;
  }, [commitHistory]);

  const copySelectedNodes = useCallback(() => {
    const selectedGraph = selectedGraphFromNodes(nodesRef.current, edgesRef.current);
    if (!selectedGraph) return false;

    copiedGraphRef.current = selectedGraph;
    pasteCountRef.current = 1;
    return true;
  }, []);

  const pasteCopiedNodes = useCallback(() => {
    const copiedGraph = copiedGraphRef.current;
    if (!copiedGraph) return false;

    const pasteOffset = {
      x: PASTE_OFFSET.x * pasteCountRef.current,
      y: PASTE_OFFSET.y * pasteCountRef.current,
    };
    const duplicatedGraph = duplicateGraph(
      copiedGraph,
      nodesRef.current,
      (node) => ({
        x: node.position.x + pasteOffset.x,
        y: node.position.y + pasteOffset.y,
      }),
    );
    if (duplicatedGraph.nodes.length === 0) return false;

    pasteCountRef.current += 1;
    commitHistory();
    setNodes((current) => [
      ...current.map((node) => ({ ...node, selected: false })),
      ...duplicatedGraph.nodes.map((node) => ({ ...node, selected: true })),
    ]);
    setEdges((current) => dedupeEdges([
      ...current.map((edge) => ({ ...edge, selected: false })),
      ...duplicatedGraph.edges,
    ]));
    setEditingTypeNodeId(null);
    return true;
  }, [commitHistory]);

  const setDuplicateDragModifier = useCallback((duplicating: boolean) => {
    const dragState = duplicateDragRef.current;
    if (!dragState || dragState.duplicating === duplicating) return;

    if (duplicating) {
      setNodes((current) => restoreGraphNodePositions(current, dragState.nodes));
      updateDuplicateDrag({ ...dragState, duplicating: true });
      return;
    }

    commitHistory('node-change');
    nodeDragHistoryRef.current = true;
    setNodes((current) => applyGraphNodePositions(current, dragState.currentPositions));
    updateDuplicateDrag({ ...dragState, duplicating: false });
  }, [commitHistory, updateDuplicateDrag]);

  const setDuplicateDragExternalLinks = useCallback((linkExternal: boolean) => {
    const dragState = duplicateDragRef.current;
    if (!dragState || dragState.linkExternal === linkExternal) return;

    updateDuplicateDrag({ ...dragState, linkExternal });
  }, [updateDuplicateDrag]);

  const onNodeDragStart = useCallback((
    event: globalThis.MouseEvent | TouchEvent,
    node: ShaderFlowNode,
    dragNodes: ShaderFlowNode[],
  ) => {
    const graph = graphFromDraggedNodes(node, dragNodes, nodesRef.current, edgesRef.current);
    if (!graph) {
      updateDuplicateDrag(null);
      return;
    }

    updateDuplicateDrag({
      ...graph,
      currentPositions: positionsByNodeId(graph.nodes),
      duplicating: isDuplicateModifierPressed(event),
      linkExternal: isCommandModifierPressed(event),
    });
  }, [updateDuplicateDrag]);

  const onNodeDrag = useCallback((
    _event: globalThis.MouseEvent | TouchEvent,
    _node: ShaderFlowNode,
    dragNodes: ShaderFlowNode[],
  ) => {
    updateDuplicateDrag((current) => current && !current.duplicating
      ? syncDuplicateDragPositions(current, dragNodes)
      : current);
  }, [updateDuplicateDrag]);

  const onNodeDragStop = useCallback((
    _event: globalThis.MouseEvent | TouchEvent,
    _node: ShaderFlowNode,
    dragNodes: ShaderFlowNode[],
  ) => {
    const currentDragState = duplicateDragRef.current;
    const dragState = currentDragState?.duplicating
      ? currentDragState
      : syncDuplicateDragPositions(currentDragState, dragNodes);
    if (!dragState) {
      updateDuplicateDrag(null);
      return;
    }

    if (dragState.duplicating) {
      const duplicatedGraph = duplicateGraph(
        dragState,
        nodesRef.current,
        (node) => dragState.currentPositions[node.id] ?? node.position,
        { includeBoundaryEdges: dragState.linkExternal },
      );

      commitHistory();
      setNodes((current) => [
        ...restoreGraphNodePositions(current, dragState.nodes).map((node) => ({ ...node, selected: false })),
        ...duplicatedGraph.nodes.map((node) => ({ ...node, selected: true })),
      ]);
      setEdges((current) => dedupeEdges([
        ...current.map((edge) => ({ ...edge, selected: false })),
        ...duplicatedGraph.edges,
      ]));
      setEditingTypeNodeId(null);
      nodeDragHistoryRef.current = false;
    }

    updateDuplicateDrag(null);
  }, [commitHistory, updateDuplicateDrag]);

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
          mode: edge.data?.mode ?? 'set',
          onWeightChange: updateEdgeWeight,
          onModeChange: updateEdgeMode,
          onInsertNode: insertNodeOnEdge,
        },
      })),
    [edges, insertNodeOnEdge, updateEdgeMode, updateEdgeWeight],
  );

  const patch = useMemo(() => patchFromFlow(nodesWithCallbacks, edgesWithCallbacks), [nodesWithCallbacks, edgesWithCallbacks]);
  const patchJson = useMemo(() => patchToJson(patch), [patch]);
  const validation = useMemo(() => validatePatch(patch), [patch]);
  const compileResult = useMemo(() => compilePatchToGlsl(patch, 'webgl2', {
    enableScopes: !uiHidden,
  }), [patch, uiHidden]);
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
  const draftNodePreview = useMemo(() => {
    if (!draftNodeConnection?.modifierActive || !reactFlow) return null;

    const position = draftNodePosition(draftNodeConnection, reactFlow);
    const link = linkForDraftNodeConnection(draftNodeConnection, DRAFT_NODE_PREVIEW_ID);
    if (!link) return null;

    const node: ShaderFlowNode = {
      id: DRAFT_NODE_PREVIEW_ID,
      type: 'shaderNode',
      position,
      draggable: false,
      selectable: false,
      connectable: false,
      deletable: false,
      className: 'shader-node-preview',
      data: {
        patchNode: {
          id: 'new',
          type: null,
          params: {},
          position,
        },
        onParamChange: updateParamPlaceholder,
        onTypeChange: updateTypePlaceholder,
        onTypeEditStart: updateTypeEditStartPlaceholder,
        onTypeEditEnd: updateTypeEditEndPlaceholder,
        onIdChange: updateIdPlaceholder,
        onPortDoubleClick: portDoubleClickPlaceholder,
        isTypePickerOpen: false,
      },
    };
    const edge = {
      ...edgeFromLink(link),
      id: `preview:${edgeId(link)}`,
      selectable: false,
      deletable: false,
      className: 'shader-edge shader-edge-preview',
    };

    return { node, edge };
  }, [draftNodeConnection, reactFlow]);
  const duplicateDragPreview = useMemo(() => {
    if (!duplicateDrag?.duplicating) return null;

    const idMap = new Map(duplicateDrag.nodes.map((node) => [node.id, duplicatePreviewNodeId(node.id)]));
    const previewNodes = duplicateDrag.nodes.map((node): ShaderFlowNode => {
      const id = idMap.get(node.id) ?? duplicatePreviewNodeId(node.id);
      const position = duplicateDrag.currentPositions[node.id] ?? node.position;

      return {
        ...node,
        id,
        position,
        draggable: false,
        selectable: false,
        connectable: false,
        deletable: false,
        className: ['shader-node-preview', node.className ?? ''].filter(Boolean).join(' '),
        data: {
          ...node.data,
          patchNode: {
            ...node.data.patchNode,
            id: node.data.patchNode.id,
            params: { ...node.data.patchNode.params },
            position,
          },
          onParamChange: updateParamPlaceholder,
          onTypeChange: updateTypePlaceholder,
          onTypeEditStart: updateTypeEditStartPlaceholder,
          onTypeEditEnd: updateTypeEditEndPlaceholder,
          onIdChange: updateIdPlaceholder,
          onPortDoubleClick: portDoubleClickPlaceholder,
          isTypePickerOpen: false,
        },
      };
    });
    const previewEdges = [
      ...duplicateDrag.edges,
      ...(duplicateDrag.linkExternal ? duplicateDrag.boundaryEdges : []),
    ].flatMap((edge) => {
      const link = linkFromEdge(edge);
      if (!link) return [];

      const fromNode = idMap.get(link.from.node) ?? link.from.node;
      const toNode = idMap.get(link.to.node) ?? link.to.node;
      if (fromNode === link.from.node && toNode === link.to.node) return [];

      return [{
        ...edgeFromLink({
          from: { ...link.from, node: fromNode },
          to: { ...link.to, node: toNode },
          weight: link.weight,
          mode: link.mode,
        }),
        selectable: false,
        deletable: false,
        className: 'shader-edge shader-edge-preview',
      }];
    });

    return { nodes: previewNodes, edges: previewEdges };
  }, [duplicateDrag]);
  const displayNodes = useMemo(
    () => [
      ...nodesWithCallbacks,
      ...(duplicateDragPreview?.nodes ?? []),
      ...(draftNodePreview ? [draftNodePreview.node] : []),
    ],
    [draftNodePreview, duplicateDragPreview, nodesWithCallbacks],
  );
  const previewEdges = useMemo(
    () => [
      ...displayEdges,
      ...(duplicateDragPreview?.edges ?? []),
      ...(draftNodePreview ? [draftNodePreview.edge] : []),
    ],
    [displayEdges, draftNodePreview, duplicateDragPreview],
  );
  useEffect(() => {
    saveEditorState(nodesWithCallbacks, edgesWithCallbacks, {
      sidePanelOpen,
      viewport,
    });
  }, [edgesWithCallbacks, nodesWithCallbacks, sidePanelOpen, viewport]);

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

  useEffect(() => {
    if (!draftNodeConnection) return;

    const updatePointer = (event: PointerEvent) => {
      updateDraftNodeConnection((current) => current ? {
        ...current,
        pointer: { x: event.clientX, y: event.clientY },
        modifierActive: isCommandModifierPressed(event),
      } : current);
    };
    const updateModifier = (event: KeyboardEvent) => {
      updateDraftNodeConnection((current) => current ? {
        ...current,
        modifierActive: isCommandModifierPressed(event),
      } : current);
    };

    window.addEventListener('pointermove', updatePointer);
    window.addEventListener('keydown', updateModifier);
    window.addEventListener('keyup', updateModifier);
    return () => {
      window.removeEventListener('pointermove', updatePointer);
      window.removeEventListener('keydown', updateModifier);
      window.removeEventListener('keyup', updateModifier);
    };
  }, [draftNodeConnection, updateDraftNodeConnection]);

  useEffect(() => {
    if (!duplicateDrag) return;

    const updateModifier = (event: KeyboardEvent) => {
      if (event.key === 'Alt') {
        setDuplicateDragModifier(event.altKey);
      }
      if (event.key === 'Meta' || event.key === 'Control' || event.key === 'Shift') {
        setDuplicateDragExternalLinks(isCommandModifierPressed(event));
      }
    };

    window.addEventListener('keydown', updateModifier);
    window.addEventListener('keyup', updateModifier);
    return () => {
      window.removeEventListener('keydown', updateModifier);
      window.removeEventListener('keyup', updateModifier);
    };
  }, [duplicateDrag, setDuplicateDragExternalLinks, setDuplicateDragModifier]);

  useEffect(() => {
    const editorShell = editorShellRef.current;
    if (!editorShell) return;

    let rafId = 0;
    const scheduleMaskUpdate = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        updateScopeEdgeMask(editorShell);
      });
    };

    const mutationObserver = new MutationObserver(() => {
      scheduleMaskUpdate();
    });
    mutationObserver.observe(editorShell, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['style', 'class'],
    });

    const resizeObserver = new ResizeObserver(() => {
      scheduleMaskUpdate();
    });
    resizeObserver.observe(editorShell);

    scheduleMaskUpdate();

    return () => {
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      cancelAnimationFrame(rafId);
      clearScopeEdgeMask(editorShell);
    };
  }, []);

  const onNodesChange = useCallback((changes: NodeChange<ShaderFlowNode>[]) => {
    const duplicateState = duplicateDragRef.current;
    if (duplicateState?.duplicating) {
      const nextDuplicateState = syncDuplicateDragPositionsFromChanges(duplicateState, changes);
      if (nextDuplicateState !== duplicateState) {
        updateDuplicateDrag(nextDuplicateState);
      }

      setNodes((current) => applyNodeChanges(
        anchorDuplicatedNodePositionChanges(changes, duplicateState.nodes),
        current,
      ));
      return;
    }

    if (shouldRecordNodeChanges(changes, nodeDragHistoryRef)) {
      commitHistory('node-change');
    }
    setNodes((current) => applyNodeChanges(changes, current));
  }, [commitHistory, updateDuplicateDrag]);

  const onEdgesChange = useCallback((changes: EdgeChange<ShaderFlowEdge>[]) => {
    if (shouldRecordEdgeChanges(changes)) {
      commitHistory();
    }
    setEdges((current) => applyEdgeChanges(changes, current));
  }, [commitHistory]);

  const onConnect = useCallback((connection: Connection) => {
    if (connection.source === DRAFT_NODE_PREVIEW_ID || connection.target === DRAFT_NODE_PREVIEW_ID) {
      return;
    }

    const candidate: ShaderFlowEdge = {
      id: `${connection.source}:${connection.sourceHandle}->${connection.target}:${connection.targetHandle}`,
      type: 'shaderEdge',
      source: connection.source ?? '',
      sourceHandle: connection.sourceHandle,
      target: connection.target ?? '',
      targetHandle: connection.targetHandle,
      data: {
        weight: 1,
        mode: 'set',
        onWeightChange: updateEdgeWeight,
        onModeChange: updateEdgeMode,
        onInsertNode: insertNodeOnEdge,
      },
      className: 'shader-edge',
    };
    const link = linkFromEdge(candidate);
    if (!link) return;

    const alreadyConnected = edges.some((edge) => {
      const existing = linkFromEdge(edge);
      return (
        existing &&
        existing.from.node === link.from.node &&
        existing.from.port === link.from.port &&
        existing.to.node === link.to.node &&
        existing.to.port === link.to.port
      );
    });
    if (alreadyConnected) return;

    commitHistory();
    setEdges((current) => {
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
            mode: 'set',
            onWeightChange: updateEdgeWeight,
            onModeChange: updateEdgeMode,
            onInsertNode: insertNodeOnEdge,
          },
        },
        current,
      );
    });
  }, [commitHistory, edges, insertNodeOnEdge, updateEdgeMode, updateEdgeWeight]);

  const addNodeAt = useCallback(
    (event: ReactMouseEvent) => {
      if (!reactFlow) return;
      commitHistory();
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
    [commitHistory, insertNodeOnPort, nodes, reactFlow, updateNodeId, updateNodeParam, updateNodeType],
  );

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }

    void document.documentElement.requestFullscreen();
  }, []);

  useEffect(() => {
    const handleAppShortcutKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || isEditableEventTarget(event.target)) return;

      const hasModifier = event.metaKey || event.ctrlKey;
      if (!hasModifier || event.altKey) return;

      const key = event.key.toLowerCase();
      if (key === 'u' && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        setUiHidden((current) => !current);
        return;
      }

      if (key === 'f' && event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        toggleFullscreen();
      }
    };

    window.addEventListener('keydown', handleAppShortcutKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleAppShortcutKeyDown, { capture: true });
    };
  }, [toggleFullscreen]);

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

    commitHistory();
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
    setEdges(toFlowEdges(loadedPatch, updateEdgeWeight, insertNodeOnEdge));
    setEditingTypeNodeId(null);
    setImportError(null);
  }, [commitHistory, insertNodeOnEdge, insertNodeOnPort, updateEdgeWeight, updateNodeId, updateNodeParam, updateNodeType]);

  const savePatchJson = useCallback(() => {
    const blob = new Blob([patchJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'visual-visual-patch.json';
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [patchJson]);

  const loadPatchFile = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;

    try {
      loadPatchJson(await file.text());
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    }
  }, [loadPatchJson]);

  const restoreSnapshot = useCallback((snapshot: GraphSnapshot) => {
    const state: PersistedEditorState = {
      version: 1,
      nodes: snapshot.nodes,
      edges: snapshot.edges,
    };

    setNodes(editorStateToFlowNodes(
      state,
      updateNodeParam,
      updateNodeType,
      setEditingTypeNodeId,
      () => setEditingTypeNodeId(null),
      updateNodeId,
      insertNodeOnPort,
      null,
    ));
    setEdges(editorStateToFlowEdges(state, updateEdgeWeight, insertNodeOnEdge));
    setEditingTypeNodeId(null);
  }, [insertNodeOnEdge, insertNodeOnPort, updateEdgeWeight, updateNodeId, updateNodeParam, updateNodeType]);

  const undo = useCallback(() => {
    const previous = history.past[history.past.length - 1];
    if (!previous) return;

    const currentSnapshot = graphSnapshot(nodesRef.current, edgesRef.current);
    restoreSnapshot(previous);
    historyGroupRef.current = null;
    nodeDragHistoryRef.current = false;
    setHistory({
      past: history.past.slice(0, -1),
      future: [currentSnapshot, ...history.future].slice(0, HISTORY_LIMIT),
    });
  }, [history, restoreSnapshot]);

  const redo = useCallback(() => {
    const next = history.future[0];
    if (!next) return;

    const currentSnapshot = graphSnapshot(nodesRef.current, edgesRef.current);
    restoreSnapshot(next);
    historyGroupRef.current = null;
    nodeDragHistoryRef.current = false;
    setHistory({
      past: [...history.past, currentSnapshot].slice(-HISTORY_LIMIT),
      future: history.future.slice(1),
    });
  }, [history, restoreSnapshot]);

  useEffect(() => {
    const handleBridgeDeleteKeyDown = (event: KeyboardEvent) => {
      if (isEditableEventTarget(event.target)) return;
      if (event.key !== 'Backspace') return;
      if (!event.metaKey && !event.ctrlKey) return;
      if (!deleteSelectedNodesWithBridge()) return;

      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener('keydown', handleBridgeDeleteKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleBridgeDeleteKeyDown, { capture: true });
    };
  }, [deleteSelectedNodesWithBridge]);

  useEffect(() => {
    const handleHistoryKeyDown = (event: KeyboardEvent) => {
      if (isEditableEventTarget(event.target)) return;
      const hasModifier = event.metaKey || event.ctrlKey;
      if (!hasModifier) return;

      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
        return;
      }
      if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault();
        redo();
      }
    };

    window.addEventListener('keydown', handleHistoryKeyDown);
    return () => {
      window.removeEventListener('keydown', handleHistoryKeyDown);
    };
  }, [redo, undo]);

  useEffect(() => {
    const handleClipboardKeyDown = (event: KeyboardEvent) => {
      if (isEditableEventTarget(event.target)) return;
      const hasModifier = event.metaKey || event.ctrlKey;
      if (!hasModifier || event.shiftKey || event.altKey) return;

      const key = event.key.toLowerCase();
      if (key === 'c' && copySelectedNodes()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (key === 'v' && pasteCopiedNodes()) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    window.addEventListener('keydown', handleClipboardKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleClipboardKeyDown, { capture: true });
    };
  }, [copySelectedNodes, pasteCopiedNodes]);

  const shellClassName = [
    'app-shell',
    sidePanelOpen && !uiHidden ? '' : 'app-shell-panel-closed',
    uiHidden ? 'app-shell-ui-hidden' : '',
  ].filter(Boolean).join(' ');

  return (
    <main
      className={shellClassName}
      onPointerDownCapture={(event) => {
        if (!uiHidden) return;
        event.preventDefault();
        event.stopPropagation();
        setUiHidden(false);
      }}
    >
      <WebGLPreview
        ref={previewRef}
        fragmentShader={compileResult.shaderCode}
        feedbackTextureCount={compileResult.feedbackTextureCount}
        shaderArgs={compileResult.shaderArgs}
        delaySlots={compileResult.delaySlots}
        envelopeSlots={compileResult.envelopeSlots}
        scopeSlots={compileResult.scopeSlots}
        meterSlots={compileResult.meterSlots}
        mediaRequirements={compileResult.media}
        onFpsChange={setFps}
      />
      <section
        ref={editorShellRef}
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
            aria-label={sidePanelOpen ? 'Hide GLSL panel' : 'Show GLSL panel'}
            title={sidePanelOpen ? 'Hide GLSL panel' : 'Show GLSL panel'}
          >
            GL
          </button>
          <button
            className="viewport-button"
            type="button"
            onClick={savePatchJson}
            aria-label="Save patch JSON"
            title="Save patch JSON"
          >
            SV
          </button>
          <button
            className="viewport-button"
            type="button"
            onClick={() => previewRef.current?.downloadScreenshot()}
            aria-label="Save screenshot PNG"
            title="Save screenshot PNG"
          >
            SS
          </button>
          <button
            className="viewport-button"
            type="button"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Load patch JSON"
            title="Load patch JSON"
          >
            LD
          </button>
          <button
            className="viewport-button viewport-button-history"
            type="button"
            onClick={undo}
            disabled={history.past.length === 0}
            aria-label="Undo"
            title="Undo"
          >
            UN
          </button>
          <button
            className="viewport-button viewport-button-history"
            type="button"
            onClick={redo}
            disabled={history.future.length === 0}
            aria-label="Redo"
            title="Redo"
          >
            RE
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
            onClick={() => setUiHidden(true)}
            aria-label="Hide UI"
            title="Hide UI"
          >
            UI
          </button>
          <input
            ref={fileInputRef}
            className="panel-file-input"
            type="file"
            accept="application/json,.json"
            onChange={loadPatchFile}
          />
        </div>
        <div className="fps-counter">{fps} FPS</div>
        <div
          ref={setEdgeOverlayElement}
          className="edge-overlay-layer"
        />
        <EdgeOverlayProvider target={uiHidden ? null : edgeOverlayElement}>
          <ReactFlow
            nodes={displayNodes}
            edges={previewEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onInit={setReactFlow}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStart={onNodeDragStart}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            onEdgeDoubleClick={(event, edge) => {
              event.preventDefault();
              event.stopPropagation();
              insertNodeOnEdge(edge.id);
            }}
            onConnect={onConnect}
            onConnectStart={onConnectStart}
            onConnectEnd={onConnectEnd}
            onMoveEnd={(_, nextViewport) => setViewport(nextViewport)}
            connectionMode={ConnectionMode.Loose}
            connectionLineStyle={draftNodePreview ? { stroke: 'transparent' } : undefined}
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
        </EdgeOverlayProvider>
      </section>
      {sidePanelOpen && !uiHidden ? (
        <ExportPanel
          shaderCode={compileResult.shaderCode}
          validation={validation}
          compileErrors={compileResult.errors}
          importError={importError}
        />
      ) : null}
    </main>
  );
}

function updateScopeEdgeMask(editorShell: HTMLElement): void {
  const rendererLayer = editorShell.querySelector<HTMLElement>('.react-flow__renderer');
  if (!rendererLayer) return;

  const scopeElements = Array.from(editorShell.querySelectorAll<HTMLElement>('.scope-preview'));
  if (scopeElements.length === 0) {
    clearScopeEdgeMask(editorShell);
    return;
  }

  const layerRect = rendererLayer.getBoundingClientRect();
  if (layerRect.width <= 0 || layerRect.height <= 0) {
    clearScopeEdgeMask(editorShell);
    return;
  }

  const maskPadding = 2;
  const borderReveal = 2;

  const maskRects = scopeElements.flatMap((element) => {
    const rect = element.getBoundingClientRect();
    const left = Math.max(rect.left, layerRect.left);
    const top = Math.max(rect.top, layerRect.top);
    const right = Math.min(rect.right, layerRect.right);
    const bottom = Math.min(rect.bottom, layerRect.bottom);
    if (right <= left || bottom <= top) return [];

    return [{
      x: left - layerRect.left - maskPadding,
      y: top - layerRect.top - maskPadding,
      width: (right - left) + maskPadding * 2,
      height: (bottom - top) + maskPadding * 2,
    }];
  });

  if (maskRects.length === 0) {
    clearScopeEdgeMask(editorShell);
    return;
  }

  const width = Math.max(1, Math.round(layerRect.width));
  const height = Math.max(1, Math.round(layerRect.height));
  const holeRects = maskRects.map((rect) => {
    const x = Math.round(rect.x + borderReveal);
    const y = Math.round(rect.y + borderReveal);
    const innerWidth = Math.max(1, Math.round(rect.width - borderReveal * 2));
    const innerHeight = Math.max(1, Math.round(rect.height - borderReveal * 2));
    return `<rect x="${x}" y="${y}" width="${innerWidth}" height="${innerHeight}" fill="black"/>`;
  });

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">`,
    '<rect x="0" y="0" width="100%" height="100%" fill="white"/>',
    ...holeRects,
    '</svg>',
  ].join('');

  const maskUrl = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  rendererLayer.style.setProperty('-webkit-mask-image', maskUrl);
  rendererLayer.style.setProperty('-webkit-mask-repeat', 'no-repeat');
  rendererLayer.style.setProperty('-webkit-mask-size', '100% 100%');
  rendererLayer.style.setProperty('-webkit-mask-mode', 'luminance');
  rendererLayer.style.setProperty('mask-image', maskUrl);
  rendererLayer.style.setProperty('mask-repeat', 'no-repeat');
  rendererLayer.style.setProperty('mask-size', '100% 100%');
  rendererLayer.style.setProperty('mask-mode', 'luminance');
}

function clearScopeEdgeMask(editorShell: HTMLElement): void {
  const rendererLayer = editorShell.querySelector<HTMLElement>('.react-flow__renderer');
  if (!rendererLayer) return;

  rendererLayer.style.removeProperty('-webkit-mask-image');
  rendererLayer.style.removeProperty('-webkit-mask-repeat');
  rendererLayer.style.removeProperty('-webkit-mask-size');
  rendererLayer.style.removeProperty('-webkit-mask-mode');
  rendererLayer.style.removeProperty('mask-image');
  rendererLayer.style.removeProperty('mask-repeat');
  rendererLayer.style.removeProperty('mask-size');
  rendererLayer.style.removeProperty('mask-mode');
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

function updateEdgeModePlaceholder() {
  // Replaced after React state exists.
}

function updateEdgeInsertPlaceholder() {
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
      mode: link.mode ?? 'set',
      onWeightChange: updateEdgeWeightPlaceholder,
      onModeChange: updateEdgeModePlaceholder,
      onInsertNode: updateEdgeInsertPlaceholder,
    },
    className: 'shader-edge',
  };
}

function selectedGraphFromNodes(nodes: ShaderFlowNode[], edges: ShaderFlowEdge[]): CopiedGraph | null {
  const selectedNodeIds = new Set(nodes.filter((node) => node.selected).map((node) => node.id));
  if (selectedNodeIds.size === 0) return null;

  return graphForNodeIds(nodes, edges, selectedNodeIds);
}

function graphFromDraggedNodes(
  node: ShaderFlowNode,
  dragNodes: ShaderFlowNode[],
  nodes: ShaderFlowNode[],
  edges: ShaderFlowEdge[],
): CopiedGraph | null {
  const selectedNodeIds = new Set(nodes.filter((candidate) => candidate.selected).map((candidate) => candidate.id));
  const draggedNodeIds = new Set(dragNodes.map((candidate) => candidate.id));
  const nodeIds = node.selected && selectedNodeIds.size > 0
    ? selectedNodeIds
    : draggedNodeIds.size > 0
      ? draggedNodeIds
      : new Set([node.id]);

  return graphForNodeIds(nodes, edges, nodeIds);
}

function graphForNodeIds(nodes: ShaderFlowNode[], edges: ShaderFlowEdge[], nodeIds: Set<string>): CopiedGraph | null {
  const graphNodes = nodes
    .filter((node) => nodeIds.has(node.id) && !node.id.startsWith(DUPLICATE_NODE_PREVIEW_PREFIX))
    .map(cloneFlowNodeSnapshot);
  if (graphNodes.length === 0) return null;

  const graphNodeIds = new Set(graphNodes.map((node) => node.id));
  const graphEdges = edges
    .filter((edge) => {
      const link = linkFromEdge(edge);
      return link && graphNodeIds.has(link.from.node) && graphNodeIds.has(link.to.node);
    })
    .map(cloneFlowEdgeSnapshot);
  const boundaryEdges = edges
    .filter((edge) => {
      const link = linkFromEdge(edge);
      if (!link) return false;

      const sourceSelected = graphNodeIds.has(link.from.node);
      const targetSelected = graphNodeIds.has(link.to.node);
      return sourceSelected !== targetSelected;
    })
    .map(cloneFlowEdgeSnapshot);

  return { nodes: graphNodes, edges: graphEdges, boundaryEdges };
}

function duplicateGraph(
  graph: CopiedGraph,
  existingNodes: ShaderFlowNode[],
  positionForNode: (node: ShaderFlowNode) => { x: number; y: number },
  options: { includeBoundaryEdges?: boolean } = {},
): CopiedGraph {
  const existingIds = new Set(existingNodes.map((node) => node.id));
  const idMap = new Map<string, string>();
  const nodes = graph.nodes.map((node): ShaderFlowNode => {
    const type = node.data.patchNode.type ?? 'node';
    const id = makeNodeId(type, existingIds);
    const position = positionForNode(node);
    existingIds.add(id);
    idMap.set(node.id, id);

    return {
      ...node,
      id,
      type: 'shaderNode',
      position,
      selected: true,
      dragging: false,
      className: removeClassName(node.className, 'shader-node-preview'),
      draggable: undefined,
      selectable: undefined,
      connectable: undefined,
      deletable: undefined,
      data: {
        ...node.data,
        patchNode: {
          id,
          type: node.data.patchNode.type,
          params: { ...node.data.patchNode.params },
          position,
        },
        onParamChange: updateParamPlaceholder,
        onTypeChange: updateTypePlaceholder,
        onTypeEditStart: updateTypeEditStartPlaceholder,
        onTypeEditEnd: updateTypeEditEndPlaceholder,
        onIdChange: updateIdPlaceholder,
        onPortDoubleClick: portDoubleClickPlaceholder,
        isTypePickerOpen: false,
      },
    };
  });
  const edges = [
    ...graph.edges,
    ...(options.includeBoundaryEdges ? graph.boundaryEdges : []),
  ].flatMap((edge) => {
    const link = linkFromEdge(edge);
    if (!link) return [];

    const fromNode = idMap.get(link.from.node) ?? link.from.node;
    const toNode = idMap.get(link.to.node) ?? link.to.node;
    if (fromNode === link.from.node && toNode === link.to.node) return [];

    return [{
      ...edgeFromLink({
        from: { ...link.from, node: fromNode },
        to: { ...link.to, node: toNode },
        weight: link.weight,
        mode: link.mode,
      }),
      selected: true,
    }];
  });

  return { nodes, edges, boundaryEdges: [] };
}

function cloneFlowNodeSnapshot(node: ShaderFlowNode): ShaderFlowNode {
  const position = { ...node.position };

  return {
    ...node,
    position,
    data: {
      ...node.data,
      patchNode: {
        ...node.data.patchNode,
        params: { ...node.data.patchNode.params },
        position,
      },
    },
  };
}

function cloneFlowEdgeSnapshot(edge: ShaderFlowEdge): ShaderFlowEdge {
  return {
    ...edge,
    data: {
      ...edge.data,
      weight: edge.data?.weight ?? 1,
      mode: edge.data?.mode ?? 'set',
      onWeightChange: updateEdgeWeightPlaceholder,
      onModeChange: updateEdgeModePlaceholder,
      onInsertNode: updateEdgeInsertPlaceholder,
    },
  };
}

function positionsByNodeId(nodes: ShaderFlowNode[]): Record<string, { x: number; y: number }> {
  return Object.fromEntries(nodes.map((node) => [node.id, { ...node.position }]));
}

function syncDuplicateDragPositions(
  state: DuplicateDragState | null,
  dragNodes: ShaderFlowNode[],
): DuplicateDragState | null {
  if (!state || dragNodes.length === 0) return state;

  const sourceIds = new Set(state.nodes.map((node) => node.id));
  let changed = false;
  const currentPositions = { ...state.currentPositions };

  for (const node of dragNodes) {
    if (!sourceIds.has(node.id)) continue;
    const previous = currentPositions[node.id];
    if (previous && previous.x === node.position.x && previous.y === node.position.y) continue;

    currentPositions[node.id] = { ...node.position };
    changed = true;
  }

  return changed ? { ...state, currentPositions } : state;
}

function syncDuplicateDragPositionsFromChanges(
  state: DuplicateDragState,
  changes: NodeChange<ShaderFlowNode>[],
): DuplicateDragState {
  const sourceIds = new Set(state.nodes.map((node) => node.id));
  let changed = false;
  const currentPositions = { ...state.currentPositions };

  for (const change of changes) {
    if (change.type !== 'position' || !change.position || !sourceIds.has(change.id)) continue;

    const previous = currentPositions[change.id];
    if (previous && previous.x === change.position.x && previous.y === change.position.y) continue;

    currentPositions[change.id] = { ...change.position };
    changed = true;
  }

  return changed ? { ...state, currentPositions } : state;
}

function anchorDuplicatedNodePositionChanges(
  changes: NodeChange<ShaderFlowNode>[],
  sourceNodes: ShaderFlowNode[],
): NodeChange<ShaderFlowNode>[] {
  const startPositions = positionsByNodeId(sourceNodes);

  return changes.map((change) => {
    if (change.type !== 'position' || !startPositions[change.id]) return change;

    return {
      ...change,
      position: { ...startPositions[change.id] },
      positionAbsolute: { ...startPositions[change.id] },
    };
  });
}

function restoreGraphNodePositions(nodes: ShaderFlowNode[], sourceNodes: ShaderFlowNode[]): ShaderFlowNode[] {
  return applyGraphNodePositions(nodes, positionsByNodeId(sourceNodes));
}

function applyGraphNodePositions(
  nodes: ShaderFlowNode[],
  positions: Record<string, { x: number; y: number }>,
): ShaderFlowNode[] {
  return nodes.map((node) => {
    const position = positions[node.id];
    if (!position) return node;

    return {
      ...node,
      position: { ...position },
      data: {
        ...node.data,
        patchNode: {
          ...node.data.patchNode,
          position: { ...position },
        },
      },
    };
  });
}

function duplicatePreviewNodeId(nodeId: string): string {
  return `${DUPLICATE_NODE_PREVIEW_PREFIX}${nodeId}`;
}

function removeClassName(className: string | undefined, classNameToRemove: string): string | undefined {
  const nextClassName = (className ?? '')
    .split(/\s+/)
    .filter((name) => name && name !== classNameToRemove)
    .join(' ');

  return nextClassName || undefined;
}

function draftNodePosition(
  connection: DraftNodeConnection,
  reactFlow: ReactFlowInstance<ShaderFlowNode, ShaderFlowEdge>,
): { x: number; y: number } {
  const pointer = reactFlow.screenToFlowPosition(connection.pointer);
  const x = connection.originHandleType === 'source'
    ? pointer.x + DRAFT_NODE_HANDLE_X_OFFSET
    : pointer.x - DRAFT_NODE_WIDTH - DRAFT_NODE_HANDLE_X_OFFSET;

  return {
    x,
    y: pointer.y - DRAFT_NODE_FIRST_PORT_Y,
  };
}

function linkForDraftNodeConnection(connection: DraftNodeConnection, draftNodeId: string): PatchLink | null {
  if (connection.originHandleType === 'source') {
    const sourcePort = portFromHandle(connection.originHandleId, 'out');
    if (!sourcePort) return null;

    return {
      from: { node: connection.originNodeId, port: sourcePort },
      to: { node: draftNodeId, port: 'value' },
    };
  }

  const targetPort = portFromHandle(connection.originHandleId, 'in');
  if (!targetPort) return null;

  return {
    from: { node: draftNodeId, port: 'value' },
    to: { node: connection.originNodeId, port: targetPort },
  };
}

function portFromHandle(handleId: string, expectedKind: 'in' | 'out'): string | null {
  const [kind, port] = handleId.split(':');
  if (kind !== expectedKind || !port) return null;
  return port;
}

function clientPointFromEvent(event: globalThis.MouseEvent | TouchEvent): { x: number; y: number } | null {
  if ('touches' in event) {
    const touch = event.touches[0] ?? event.changedTouches[0];
    return touch ? { x: touch.clientX, y: touch.clientY } : null;
  }

  return { x: event.clientX, y: event.clientY };
}

function isCommandModifierPressed(event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): boolean {
  return event.metaKey || event.ctrlKey || event.shiftKey;
}

function isDuplicateModifierPressed(event: globalThis.MouseEvent | TouchEvent): boolean {
  return event instanceof MouseEvent ? event.altKey : false;
}

function buildBridgeEdges(
  nodes: ShaderFlowNode[],
  edges: ShaderFlowEdge[],
  selectedNodeIds: Set<string>,
): ShaderFlowEdge[] {
  return nodes.flatMap((node) => {
    if (!selectedNodeIds.has(node.id) || node.data.patchNode.type === null) {
      return [];
    }

    const definition = getDefinition(node.data.patchNode.type);
    const inputOrder = new Map(definition.inputs.map((input, index) => [input.name, index]));
    const outputOrder = new Map(definition.outputs.map((output, index) => [output.name, index]));
    const relatedLinks = edges
      .map((edge, index) => ({ edge, link: linkFromEdge(edge), index }))
      .filter((entry): entry is { edge: ShaderFlowEdge; link: NonNullable<ReturnType<typeof linkFromEdge>>; index: number } => (
        entry.link !== null
      ));

    const incoming = relatedLinks
      .filter(({ link }) => link.to.node === node.id && !selectedNodeIds.has(link.from.node))
      .sort((a, b) => comparePortsByOrder(inputOrder, a.link.to.port, b.link.to.port, a.index, b.index));
    const outgoing = relatedLinks
      .filter(({ link }) => link.from.node === node.id && !selectedNodeIds.has(link.to.node))
      .sort((a, b) => comparePortsByOrder(outputOrder, a.link.from.port, b.link.from.port, a.index, b.index));
    const pairCount = Math.min(incoming.length, outgoing.length);
    const bridgedEdges: ShaderFlowEdge[] = [];

    for (let index = 0; index < pairCount; index += 1) {
      const upstream = incoming[index].link;
      const downstream = outgoing[index].link;
      if (upstream.from.node === downstream.to.node) {
        continue;
      }

      bridgedEdges.push(edgeFromLink({
        from: upstream.from,
        to: downstream.to,
        weight: downstream.weight,
        mode: downstream.mode,
      }));
    }

    return bridgedEdges;
  });
}

function comparePortsByOrder(
  order: Map<string, number>,
  aPort: string,
  bPort: string,
  aIndex: number,
  bIndex: number,
): number {
  const aOrder = order.get(aPort) ?? Number.MAX_SAFE_INTEGER;
  const bOrder = order.get(bPort) ?? Number.MAX_SAFE_INTEGER;
  return aOrder - bOrder || aIndex - bIndex;
}

function graphSnapshot(nodes: ShaderFlowNode[], edges: ShaderFlowEdge[]): GraphSnapshot {
  const state = flowToEditorState(nodes, edges);
  return {
    nodes: state.nodes,
    edges: state.edges,
  };
}

function graphSnapshotKey(snapshot: GraphSnapshot): string {
  return JSON.stringify(snapshot);
}

function shouldRecordNodeChanges(
  changes: NodeChange<ShaderFlowNode>[],
  dragHistoryRef: MutableRefObject<boolean>,
): boolean {
  let shouldRecord = false;

  for (const change of changes) {
    if (change.type === 'select' || change.type === 'dimensions') {
      continue;
    }

    if (change.type === 'position') {
      if (change.dragging) {
        if (!dragHistoryRef.current) {
          dragHistoryRef.current = true;
          shouldRecord = true;
        }
        continue;
      }

      if (dragHistoryRef.current) {
        dragHistoryRef.current = false;
        continue;
      }
    }

    shouldRecord = true;
  }

  return shouldRecord;
}

function shouldRecordEdgeChanges(changes: EdgeChange<ShaderFlowEdge>[]): boolean {
  return changes.some((change) => change.type !== 'select');
}

function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return (
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select' ||
    target.isContentEditable
  );
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
  const mode = value.mode;
  if (mode !== undefined && !isLinkMode(mode)) {
    throw new Error(`Link ${index} mode must be "set", "add", or "multiply".`);
  }

  return {
    from,
    to,
    ...(weight === undefined ? {} : { weight }),
    ...(mode === undefined ? {} : { mode }),
  };
}

function isLinkMode(value: unknown): value is LinkMode {
  return value === 'set' || value === 'add' || value === 'multiply';
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

import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Connection,
  ConnectionMode,
  Controls,
  EdgeChange,
  HandleType,
  NodeChange,
  OnConnectEnd,
  OnConnectStartParams,
  ReactFlow,
  ReactFlowInstance,
  ReactFlowProvider,
  SelectionMode,
  Viewport,
  type CoordinateExtent,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent, type MutableRefObject } from 'react';
import { extractExpressionInputs } from '../graph/expression';
import { compilePatchToGlsl } from '../graph/glsl';
import { defaultParamsFor, getDefinition, getNodeDefinition, NODE_TYPE_LIST } from '../graph/nodeTypes';
import { patchToJson } from '../graph/serialize';
import type { LinkMode, NodeDefinition, NodeType, Patch, PatchLink, PatchNode, PortDefinition } from '../graph/types';
import { validatePatch } from '../graph/validate';
import { ExportPanel } from '../export/ExportPanel';
import { renderBundleFromCompileResult, renderBundleRevision } from '../render/renderBundle';
import { useRenderSyncPublisher } from '../sync/renderSync';
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
const MIDI_CC_STORAGE_KEY = 'visual-visual.midi-cc-values.v1';
const MIDI_CC_PERSIST_DELAY_MS = 120;
const HISTORY_LIMIT = 100;
const DRAFT_NODE_PREVIEW_ID = '__draft_node_preview__';
const DUPLICATE_NODE_PREVIEW_PREFIX = '__duplicate_node_preview__:';
const PASTE_OFFSET = { x: 36, y: 36 };
const DRAFT_NODE_WIDTH = 168;
const DRAFT_NODE_HANDLE_X_OFFSET = 13;
const DRAFT_NODE_FIRST_PORT_Y = 52;
const DEFAULT_EXPRESSION = 'a';
const SELECTED_EDGE_Z_INDEX = 10000;
const MAX_FLOW_OFFSCREEN_RATIO = 0.5;
const DEFAULT_NODE_BOUNDS = { width: 240, height: 96 };
const FLOW_INFINITE_EXTENT: CoordinateExtent = [[Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY], [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]];
let subpatchCloneSequence = 0;

type GraphSnapshot = Pick<PersistedEditorState, 'nodes' | 'edges'>;
type HistoryState = { past: GraphSnapshot[]; future: GraphSnapshot[] };
type MidiCcValueMap = Map<string, number>;
type EditorSize = { width: number; height: number };

interface ImportedSubpatchCandidate {
  key: string;
  name: string;
  path: string;
  sourceNodeId: string;
  subpatch: Patch;
  inputCount: number;
  outputCount: number;
  nodeCount: number;
}

interface SubpatchImportModalState {
  fileName: string;
  candidates: ImportedSubpatchCandidate[];
  selectedKey: string | null;
  error: string | null;
}

interface DraftNodeConnection {
  originNodeId: string;
  originHandleId: string;
  originHandleType: HandleType;
  pointer: { x: number; y: number };
  modifierActive: boolean;
}

interface BoundaryPortSelection {
  nodeId: string;
  side: 'input' | 'output';
  port: string;
}

interface CopiedGraph {
  nodes: ShaderFlowNode[];
  edges: ShaderFlowEdge[];
  boundaryEdges: ShaderFlowEdge[];
}

interface DuplicateGraphResult extends CopiedGraph {
  sourceSubpatchCloneIds: Record<string, string>;
}

interface CopiedGraphClipboardPayload {
  app: 'visual-visual';
  kind: 'copied-graph';
  version: 1;
  graph: {
    nodes: PersistedEditorState['nodes'];
    edges: PersistedEditorState['edges'];
    boundaryEdges: PersistedEditorState['edges'];
  };
}

interface DuplicateDragState extends CopiedGraph {
  currentPositions: Record<string, { x: number; y: number }>;
  duplicating: boolean;
  linkExternal: boolean;
}

interface SubpatchEditFrame {
  groupId: string;
  parentNodes: ShaderFlowNode[];
  parentEdges: ShaderFlowEdge[];
  parentPatchName: string;
  parentHistory: HistoryState;
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
  const [patchName, setPatchName] = useState(initialState?.ui?.patchName ?? 'untitled-patch');
  const [visualizationVisible, setVisualizationVisible] = useState(initialState?.ui?.visualizationVisible ?? true);
  const [importError, setImportError] = useState<string | null>(null);
  const [uiHidden, setUiHidden] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [viewport, setViewport] = useState<Viewport>(initialState?.ui?.viewport ?? { x: 0, y: 0, zoom: 1 });
  const [viewportForBounds, setViewportForBounds] = useState<Viewport>(initialState?.ui?.viewport ?? { x: 0, y: 0, zoom: 1 });
  const [editorSize, setEditorSize] = useState<EditorSize>({ width: 0, height: 0 });
  const [subpatchImportModal, setSubpatchImportModal] = useState<SubpatchImportModalState | null>(null);
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
          portNameChangePlaceholder,
          portMovePlaceholder,
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
          portNameChangePlaceholder,
          portMovePlaceholder,
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
  const pendingBoundaryPortRef = useRef<BoundaryPortSelection | null>(null);
  const duplicateDragRef = useRef<DuplicateDragState | null>(null);
  const reconnectingEdgeRef = useRef(false);
  const reconnectDuplicateRef = useRef(false);
  const reconnectPreviewSourceRef = useRef<ShaderFlowEdge | null>(null);
  const historyGroupRef = useRef<{ key: string; time: number } | null>(null);
  const nodeDragHistoryRef = useRef(false);
  const edgeSelectionTimeoutRef = useRef<number | null>(null);
  const [history, setHistory] = useState<HistoryState>({
    past: [],
    future: [],
  });
  const [editingStack, setEditingStack] = useState<SubpatchEditFrame[]>([]);
  const [draftNodeConnection, setDraftNodeConnection] = useState<DraftNodeConnection | null>(null);
  const [pendingBoundaryPort, setPendingBoundaryPort] = useState<BoundaryPortSelection | null>(null);
  const [selectedBoundaryPort, setSelectedBoundaryPort] = useState<BoundaryPortSelection | null>(null);
  const [duplicateDrag, setDuplicateDrag] = useState<DuplicateDragState | null>(null);
  const [reconnectPreviewEdge, setReconnectPreviewEdge] = useState<ShaderFlowEdge | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  const editorShellRef = useRef<HTMLElement | null>(null);
  const previewRef = useRef<WebGLPreviewHandle | null>(null);
  const midiCcValuesRef = useRef<MidiCcValueMap>(loadMidiCcValues());
  const midiCcPersistTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

  useEffect(() => {
    const editorShell = editorShellRef.current;
    if (!editorShell) return;

    const updateEditorSize = () => {
      const rect = editorShell.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      setEditorSize((current) => (
        current.width === width && current.height === height ? current : { width, height }
      ));
    };

    updateEditorSize();
    const resizeObserver = new ResizeObserver(updateEditorSize);
    resizeObserver.observe(editorShell);

    return () => resizeObserver.disconnect();
  }, []);

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

  useEffect(() => {
    pendingBoundaryPortRef.current = pendingBoundaryPort;
  }, [pendingBoundaryPort]);

  useEffect(() => () => {
    if (edgeSelectionTimeoutRef.current !== null) {
      window.clearTimeout(edgeSelectionTimeoutRef.current);
    }
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

  const persistMidiCcValues = useCallback(() => {
    saveMidiCcValues(midiCcValuesRef.current);
  }, []);

  const schedulePersistMidiCcValues = useCallback(() => {
    if (midiCcPersistTimeoutRef.current !== null) return;

    midiCcPersistTimeoutRef.current = window.setTimeout(() => {
      midiCcPersistTimeoutRef.current = null;
      persistMidiCcValues();
    }, MIDI_CC_PERSIST_DELAY_MS);
  }, [persistMidiCcValues]);

  const syncGraphMidiCcValues = useCallback(() => {
    const values = midiCcValuesRef.current;
    setNodes((current) => syncNodesWithMidiCcValues(current, values));
    setEditingStack((current) => syncEditingStackMidiCcValues(current, values));
  }, []);

  const updateMidiCcValue = useCallback((channel: number, cc: number, value: number) => {
    const normalizedChannel = normalizeMidiChannel(channel);
    const normalizedCc = normalizeMidiCc(cc);
    const normalizedValue = normalizeMidiValue(value);
    const key = midiCcKey(normalizedChannel, normalizedCc);
    const previousValue = midiCcValuesRef.current.get(key);
    if (previousValue !== undefined && Math.abs(previousValue - normalizedValue) < 0.000001) {
      return;
    }

    midiCcValuesRef.current.set(key, normalizedValue);
    schedulePersistMidiCcValues();
    syncGraphMidiCcValues();
  }, [schedulePersistMidiCcValues, syncGraphMidiCcValues]);

  useEffect(() => {
    syncGraphMidiCcValues();
  }, [editingStack, nodes, syncGraphMidiCcValues]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || typeof navigator.requestMIDIAccess !== 'function') {
      return;
    }

    let disposed = false;
    let access: MIDIAccess | null = null;
    let stateListener: ((event: Event) => void) | null = null;
    const attachedInputs = new Set<MIDIInput>();

    const handleMidiMessage = (event: MIDIMessageEvent) => {
      const data = event.data;
      if (!data || data.length < 3) return;

      const status = data[0] & 0xf0;
      if (status !== 0xb0) return;

      const channel = (data[0] & 0x0f) + 1;
      const cc = data[1];
      const value = data[2] / 127;
      updateMidiCcValue(channel, cc, value);
    };

    const detachInputs = () => {
      for (const input of attachedInputs) {
        if (input.onmidimessage === handleMidiMessage) {
          input.onmidimessage = null;
        }
      }
      attachedInputs.clear();
    };

    const attachInputs = (midiAccess: MIDIAccess) => {
      detachInputs();
      for (const input of midiAccess.inputs.values()) {
        input.onmidimessage = handleMidiMessage;
        attachedInputs.add(input);
      }
    };

    void navigator.requestMIDIAccess().then((midiAccess) => {
      if (disposed) return;

      access = midiAccess;
      attachInputs(midiAccess);
      stateListener = () => {
        if (!access) return;
        attachInputs(access);
      };
      midiAccess.addEventListener('statechange', stateListener);
    }).catch(() => {
      // MIDI permissions can be denied or unsupported by the host browser.
    });

    return () => {
      disposed = true;
      detachInputs();
      if (access && stateListener) {
        access.removeEventListener('statechange', stateListener);
      }
    };
  }, [updateMidiCcValue]);

  useEffect(() => {
    return () => {
      if (midiCcPersistTimeoutRef.current !== null) {
        window.clearTimeout(midiCcPersistTimeoutRef.current);
        midiCcPersistTimeoutRef.current = null;
      }
      persistMidiCcValues();
    };
  }, [persistMidiCcValues]);

  const updateNodeParam = useCallback((nodeId: string, port: string, value: number) => {
    commitHistory(`param:${nodeId}:${port}`);
    setNodes((current) =>
      syncNodesWithMidiCcValues(current.map((node) =>
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
      ), midiCcValuesRef.current),
    );
  }, [commitHistory]);

  const updateNodeExpression = useCallback((nodeId: string, expression: string) => {
    setNodes((current) =>
      current.map((node) => {
        if (node.id !== nodeId || node.data.patchNode.type !== 'Expression') return node;

        return {
          ...node,
          data: {
            ...node.data,
            patchNode: {
              ...node.data.patchNode,
              expression,
            },
          },
        };
      }),
    );
  }, [commitHistory]);

  const commitNodeExpression = useCallback((nodeId: string, expression: string) => {
    const nextInputs = expressionInputDefinitions(expression);
    const nextInputNames = new Set(nextInputs.map((input) => input.name));
    const currentNode = nodesRef.current.find((node) => node.id === nodeId);
    if (!currentNode || currentNode.data.patchNode.type !== 'Expression') return;
    if (
      currentNode.data.patchNode.expression === expression &&
      samePortDefinitions(currentNode.data.patchNode.inputs ?? [], nextInputs)
    ) {
      return;
    }

    commitHistory();

    setNodes((current) =>
      current.map((node) => {
        if (node.id !== nodeId || node.data.patchNode.type !== 'Expression') return node;

        return {
          ...node,
          data: {
            ...node.data,
            patchNode: {
              ...node.data.patchNode,
              expression,
              inputs: nextInputs,
              params: syncParamsToInputs(node.data.patchNode.params, nextInputs),
            },
          },
        };
      }),
    );
    setEdges((current) => dedupeEdges(current.filter((edge) => {
      const link = linkFromEdge(edge);
      if (!link) return false;
      return link.to.node !== nodeId || nextInputNames.has(link.to.port);
    })));
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
    const previousDefinition = previousType ? getNodeDefinition(relatedNode.data.patchNode as PatchNode) : null;
    const nextExpression = relatedNode.data.patchNode.expression ?? DEFAULT_EXPRESSION;
    const nextInputs = type === 'Expression'
      ? expressionInputDefinitions(nextExpression)
      : getDefinition(type).inputs;
    const nextDefinition = {
      ...getDefinition(type),
      inputs: nextInputs,
    };
    const nextId = shouldAutoRenameForTypeChange(nodeId, previousType)
      ? nextTypeNodeId(nodeId, type, nodes)
      : nodeId;

    commitHistory();
    setNodes((current) =>
      current.map((node) => {
        if (node.id !== nodeId) return node;

        const previousInputs = previousDefinition?.inputs ?? [];
        const nextParams = type === 'Expression'
          ? syncParamsToInputs({}, nextInputs)
          : defaultParamsFor(type);

        for (const [index, input] of nextInputs.entries()) {
          const previousInput = previousInputs[index];
          if (previousInput && node.data.patchNode.params[previousInput.name] !== undefined) {
            nextParams[input.name] = node.data.patchNode.params[previousInput.name];
          }
        }

        const nextNodeParams = type === 'midiCC'
          ? syncMidiCcParams(nextParams, midiCcValuesRef.current)
          : nextParams;

        return {
          ...node,
          id: nextId,
          data: {
            ...node.data,
            patchNode: {
              ...node.data.patchNode,
              id: nextId,
              type,
              ...(type === 'Expression' ? { expression: nextExpression } : { expression: undefined }),
              params: nextNodeParams,
              ...(type === 'Group' ? {
                inputs: node.data.patchNode.inputs,
                outputs: node.data.patchNode.outputs,
                subpatch: node.data.patchNode.subpatch,
                subpatchName: node.data.patchNode.subpatchName ?? node.id,
                subpatchCloneId: node.data.patchNode.subpatchCloneId ?? makeSubpatchCloneId(node.id),
              } : type === 'Expression' ? {
                inputs: nextInputs,
                outputs: undefined,
                subpatch: undefined,
                subpatchName: undefined,
                subpatchCloneId: undefined,
              } : {
                inputs: undefined,
                outputs: undefined,
                subpatch: undefined,
                subpatchName: undefined,
                subpatchCloneId: undefined,
              }),
            },
          },
        };
      }),
    );
    setEdges((current) =>
      dedupeEdges(current.flatMap((edge) => {
        const renamedEdge = renameEdgeNode(edge, nodeId, nextId);
        const remapped = remapEdgeForNodeType(renamedEdge, nextId, previousDefinition, nextDefinition);
        return remapped ? [remapped] : [];
      })),
    );
    setEditingTypeNodeId((current) => current === nodeId ? nextId : current);
  }, [commitHistory, nodes]);

  const updateBoundaryPortName = useCallback((nodeId: string, side: 'input' | 'output', port: string, requestedPort: string) => {
    const relatedNode = nodesRef.current.find((node) => node.id === nodeId);
    if (!relatedNode || !canRenameBoundaryPort(relatedNode.data.patchNode as PatchNode, side)) return;

    const ports = side === 'input'
      ? relatedNode.data.patchNode.inputs ?? []
      : relatedNode.data.patchNode.outputs ?? [];
    const nextPort = uniqueBoundaryPortName(requestedPort, port, ports.map((entry) => entry.name));
    if (!nextPort || nextPort === port) return;

    const frame = editingStack[editingStack.length - 1];
    commitHistory();
    setNodes((current) => current.map((node) => {
      if (node.id !== nodeId) return node;

      const renamedInputs = side === 'input'
        ? renamePortDefinitions(node.data.patchNode.inputs, port, nextPort)
        : node.data.patchNode.inputs;
      const renamedOutputs = side === 'output'
        ? renamePortDefinitions(node.data.patchNode.outputs, port, nextPort)
        : node.data.patchNode.outputs;
      const params = side === 'input'
        ? renameParamKey(node.data.patchNode.params, port, nextPort)
        : node.data.patchNode.params;

      return {
        ...node,
        data: {
          ...node.data,
          patchNode: {
            ...node.data.patchNode,
            params,
            ...(renamedInputs ? { inputs: renamedInputs } : {}),
            ...(renamedOutputs ? { outputs: renamedOutputs } : {}),
          },
        },
      };
    }));
    setEdges((current) => dedupeEdges(current.map((edge) => renameEdgePort(edge, nodeId, side, port, nextPort))));

    if (frame) {
      setEditingStack((current) => current.map((entry, index) => {
        if (index !== current.length - 1) return entry;

        return {
          ...entry,
          parentEdges: dedupeEdges(entry.parentEdges.map((edge) => renameGroupBoundaryEdgePort(
            edge,
            entry.groupId,
            relatedNode.data.patchNode.type === 'Ins' ? 'input' : 'output',
            port,
            nextPort,
          ))),
          parentNodes: entry.parentNodes.map((node) => {
            if (node.id !== entry.groupId) return node;
            return {
              ...node,
              data: {
                ...node.data,
                patchNode: {
                  ...node.data.patchNode,
                  params: relatedNode.data.patchNode.type === 'Ins'
                    ? renameParamKey(node.data.patchNode.params, port, nextPort)
                    : node.data.patchNode.params,
                },
              },
            };
          }),
        };
      }));
    }
  }, [commitHistory, editingStack]);

  const updateBoundaryPortOrder = useCallback((nodeId: string, side: 'input' | 'output', port: string, direction: -1 | 1) => {
    const relatedNode = nodesRef.current.find((node) => node.id === nodeId);
    if (!relatedNode || !canRenameBoundaryPort(relatedNode.data.patchNode as PatchNode, side)) return;

    const ports = side === 'input'
      ? relatedNode.data.patchNode.inputs
      : relatedNode.data.patchNode.outputs;
    if (!ports || movePortDefinitions(ports, port, direction) === ports) return;

    commitHistory();
    setNodes((current) => current.map((node) => {
      if (node.id !== nodeId) return node;

      const movedInputs = side === 'input'
        ? movePortDefinitions(node.data.patchNode.inputs, port, direction)
        : node.data.patchNode.inputs;
      const movedOutputs = side === 'output'
        ? movePortDefinitions(node.data.patchNode.outputs, port, direction)
        : node.data.patchNode.outputs;

      return {
        ...node,
        data: {
          ...node.data,
          patchNode: {
            ...node.data.patchNode,
            ...(movedInputs ? { inputs: movedInputs } : {}),
            ...(movedOutputs ? { outputs: movedOutputs } : {}),
          },
        },
      };
    }));
  }, [commitHistory]);

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
        onPortNameChange: portNameChangePlaceholder,
        onPortMove: portMovePlaceholder,
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
        onPortNameChange: portNameChangePlaceholder,
        onPortMove: portMovePlaceholder,
        isTypePickerOpen: true,
      },
    };

    commitHistory();
    setNodes((current) => [...current, insertedNode]);
    setEdges((current) => dedupeEdges([...current, edgeFromLink(link)]));
    setEditingTypeNodeId(id);
  }, [commitHistory, reactFlow, updateNodeId, updateNodeParam, updateNodeType]);

  const materializePendingBoundaryPort = useCallback((pending: BoundaryPortSelection): void => {
    const relatedNode = nodesRef.current.find((node) => node.id === pending.nodeId);
    if (!relatedNode || !canRenameBoundaryPort(relatedNode.data.patchNode as PatchNode, pending.side)) return;

    setNodes((current) => current.map((node) => {
      if (node.id !== pending.nodeId) return node;

      const currentInputs = node.data.patchNode.inputs ?? [];
      const currentOutputs = node.data.patchNode.outputs ?? [];
      const inputExists = currentInputs.some((port) => port.name === pending.port);
      const outputExists = currentOutputs.some((port) => port.name === pending.port);
      if ((pending.side === 'input' && inputExists) || (pending.side === 'output' && outputExists)) {
        return node;
      }

      const nextInputs = pending.side === 'input'
        ? [...currentInputs.map((port) => ({ ...port })), { name: pending.port, defaultValue: 0 }]
        : currentInputs;
      const nextOutputs = pending.side === 'output'
        ? [...currentOutputs.map((port) => ({ ...port })), { name: pending.port }]
        : currentOutputs;
      const nextParams = pending.side === 'input'
        ? { ...node.data.patchNode.params, [pending.port]: 0 }
        : node.data.patchNode.params;

      return {
        ...node,
        data: {
          ...node.data,
          patchNode: {
            ...node.data.patchNode,
            params: nextParams,
            ...(node.data.patchNode.inputs !== undefined || pending.side === 'input' ? { inputs: nextInputs } : {}),
            ...(node.data.patchNode.outputs !== undefined || pending.side === 'output' ? { outputs: nextOutputs } : {}),
          },
        },
      };
    }));

    const frame = editingStack[editingStack.length - 1];
    if (!frame) return;

    setEditingStack((current) => current.map((entry, index) => {
      if (index !== current.length - 1) return entry;

      return {
        ...entry,
        parentNodes: entry.parentNodes.map((node) => {
          if (node.id !== entry.groupId) return node;

          const existingInputs = node.data.patchNode.inputs ?? [];
          const existingOutputs = node.data.patchNode.outputs ?? [];

          if (relatedNode.data.patchNode.type === 'Ins' && pending.side === 'output') {
            if (existingInputs.some((port) => port.name === pending.port)) return node;
            return {
              ...node,
              data: {
                ...node.data,
                patchNode: {
                  ...node.data.patchNode,
                  params: { ...node.data.patchNode.params, [pending.port]: 0 },
                  inputs: [...existingInputs.map((port) => ({ ...port })), { name: pending.port, defaultValue: 0 }],
                },
              },
            };
          }

          if (relatedNode.data.patchNode.type === 'Outs' && pending.side === 'input') {
            if (existingOutputs.some((port) => port.name === pending.port)) return node;
            return {
              ...node,
              data: {
                ...node.data,
                patchNode: {
                  ...node.data.patchNode,
                  outputs: [...existingOutputs.map((port) => ({ ...port })), { name: pending.port }],
                },
              },
            };
          }

          return node;
        }),
      };
    }));
  }, [editingStack]);

  const onConnectStart = useCallback((event: globalThis.MouseEvent | TouchEvent, params: OnConnectStartParams) => {
    if (reconnectingEdgeRef.current) {
      updateDraftNodeConnection(null);
      setPendingBoundaryPort(null);
      return;
    }

    const pointer = clientPointFromEvent(event);
    if (!pointer || !params.nodeId || !params.handleId || !params.handleType) {
      updateDraftNodeConnection(null);
      setPendingBoundaryPort(null);
      return;
    }

    if (editingStack.length > 0) {
      const insNode = nodesRef.current.find((node) => node.data.patchNode.type === 'Ins');
      const outsNode = nodesRef.current.find((node) => node.data.patchNode.type === 'Outs');
      let nextPending: BoundaryPortSelection | null = null;

      if (params.handleType === 'target' && insNode && params.nodeId !== insNode.id) {
        const usedNames = new Set((insNode.data.patchNode.outputs ?? []).map((port) => port.name));
        nextPending = {
          nodeId: insNode.id,
          side: 'output',
          port: uniquePortName('new_input', usedNames),
        };
      }

      if (params.handleType === 'source' && outsNode && params.nodeId !== outsNode.id) {
        const usedNames = new Set((outsNode.data.patchNode.inputs ?? []).map((port) => port.name));
        nextPending = {
          nodeId: outsNode.id,
          side: 'input',
          port: uniquePortName('new_output', usedNames),
        };
      }

      setPendingBoundaryPort(nextPending);
    } else {
      setPendingBoundaryPort(null);
    }

    updateDraftNodeConnection({
      originNodeId: params.nodeId,
      originHandleId: params.handleId,
      originHandleType: params.handleType,
      pointer,
      modifierActive: isCommandModifierPressed(event),
    });
  }, [editingStack.length, updateDraftNodeConnection]);

  const onConnectEnd = useCallback<OnConnectEnd>((event, connectionState) => {
    if (reconnectingEdgeRef.current) {
      setPendingBoundaryPort(null);
      updateDraftNodeConnection(null);
      return;
    }

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
    setPendingBoundaryPort(null);
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
    void writeCopiedGraphToClipboard(selectedGraph);
    return true;
  }, []);

  const pasteCopiedNodes = useCallback(async () => {
    const clipboardGraph = await readCopiedGraphFromClipboard();
    const copiedGraph = clipboardGraph ?? copiedGraphRef.current;
    if (!copiedGraph) return false;

    if (clipboardGraph) {
      copiedGraphRef.current = clipboardGraph;
      if (pasteCountRef.current === 0) {
        pasteCountRef.current = 1;
      }
    }
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
      ...applySourceSubpatchCloneIds(current, duplicatedGraph.sourceSubpatchCloneIds)
        .map((node) => ({ ...node, selected: false })),
      ...duplicatedGraph.nodes.map((node) => ({ ...node, selected: true })),
    ]);
    setEdges((current) => dedupeEdges([
      ...current.map((edge) => ({ ...edge, selected: false })),
      ...duplicatedGraph.edges,
    ]));
    setEditingTypeNodeId(null);
    return true;
  }, [commitHistory]);

  const groupSelectedNodes = useCallback(() => {
    const groupedGraph = groupSelectedGraph(nodesRef.current, edgesRef.current);
    if (!groupedGraph) return false;

    commitHistory();
    setNodes(groupedGraph.nodes);
    setEdges(groupedGraph.edges);
    setEditingTypeNodeId(null);
    return true;
  }, [commitHistory]);

  const enterGroupNode = useCallback((node: ShaderFlowNode) => {
    const patchNode = node.data.patchNode;
    if (patchNode.type !== 'Group') return false;

    const subpatch = patchNode.subpatch ?? emptySubpatchForGroup(patchNode as PatchNode, node.position);
    setEditingStack((current) => [
      ...current,
      {
        groupId: node.id,
        parentNodes: nodesRef.current.map(cloneFlowNodeSnapshot),
        parentEdges: edgesRef.current.map(cloneFlowEdgeSnapshot),
        parentPatchName: patchName,
        parentHistory: history,
      },
    ]);
    setNodes(toFlowNodes(
      subpatch,
      updateNodeParam,
      updateNodeType,
      setEditingTypeNodeId,
      () => setEditingTypeNodeId(null),
      updateNodeId,
      insertNodeOnPort,
      updateBoundaryPortName,
      updateBoundaryPortOrder,
      null,
    ));
    setEdges(toFlowEdges(subpatch, updateEdgeWeight, insertNodeOnEdge));
    setPatchName(patchNode.subpatchName ?? node.id);
    setEditingTypeNodeId(null);
    copiedGraphRef.current = null;
    pasteCountRef.current = 0;
    historyGroupRef.current = null;
    nodeDragHistoryRef.current = false;
    setHistory({ past: [], future: [] });
    return true;
  }, [history, insertNodeOnEdge, insertNodeOnPort, patchName, updateBoundaryPortName, updateBoundaryPortOrder, updateEdgeWeight, updateNodeId, updateNodeParam, updateNodeType]);

  const exitSubpatch = useCallback(() => {
    const frame = editingStack[editingStack.length - 1];
    if (!frame) return false;

    const subpatch = patchFromFlow(nodesRef.current, edgesRef.current);
    const parentGraph = applySubpatchToParent(frame, subpatch, patchName);
    const previousParentSnapshot = graphSnapshot(frame.parentNodes, frame.parentEdges);

    setEditingStack((current) => current.slice(0, -1));
    setNodes(parentGraph.nodes);
    setEdges(parentGraph.edges);
    setPatchName(frame.parentPatchName);
    setEditingTypeNodeId(null);
    copiedGraphRef.current = null;
    pasteCountRef.current = 0;
    historyGroupRef.current = null;
    nodeDragHistoryRef.current = false;
    setHistory({
      past: [...frame.parentHistory.past, previousParentSnapshot].slice(-HISTORY_LIMIT),
      future: [],
    });
    return true;
  }, [editingStack, patchName]);

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
        ...applySourceSubpatchCloneIds(
          restoreGraphNodePositions(current, dragState.nodes),
          duplicatedGraph.sourceSubpatchCloneIds,
        ).map((node) => ({ ...node, selected: false })),
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

  const selectedLinkPortsByNode = useMemo(() => {
    const portsByNode = new Map<string, { inputs: Set<string>; outputs: Set<string> }>();

    const ensureEntry = (nodeId: string) => {
      const existing = portsByNode.get(nodeId);
      if (existing) return existing;

      const entry = { inputs: new Set<string>(), outputs: new Set<string>() };
      portsByNode.set(nodeId, entry);
      return entry;
    };

    for (const edge of edges) {
      if (edge.selected !== true) continue;

      const link = linkFromEdge(edge);
      if (!link) continue;

      ensureEntry(link.from.node).outputs.add(link.from.port);
      ensureEntry(link.to.node).inputs.add(link.to.port);
    }

    return new Map([...portsByNode].map(([nodeId, ports]) => [
      nodeId,
      {
        inputs: [...ports.inputs],
        outputs: [...ports.outputs],
      },
    ]));
  }, [edges]);

  const nodesWithCallbacks = useMemo(
    () =>
      nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          onParamChange: updateNodeParam,
          onExpressionChange: updateNodeExpression,
          onExpressionCommit: commitNodeExpression,
          onTypeChange: updateNodeType,
          onTypeEditStart: setEditingTypeNodeId,
          onTypeEditEnd: () => setEditingTypeNodeId(null),
          onIdChange: updateNodeId,
          onPortDoubleClick: insertNodeOnPort,
          onPortNameChange: updateBoundaryPortName,
          onPortMove: updateBoundaryPortOrder,
          onPortSelect: (nodeId: string, side: 'input' | 'output', port: string) => {
            setSelectedBoundaryPort({ nodeId, side, port });
          },
          selectedPort: selectedBoundaryPort && selectedBoundaryPort.nodeId === node.id
            ? { side: selectedBoundaryPort.side, name: selectedBoundaryPort.port }
            : null,
          selectedLinkPorts: selectedLinkPortsByNode.get(node.id),
          previewPort: pendingBoundaryPort && pendingBoundaryPort.nodeId === node.id
            ? { side: pendingBoundaryPort.side, name: pendingBoundaryPort.port }
            : null,
          isTypePickerOpen: editingTypeNodeId === node.id,
        },
      })),
    [
      editingTypeNodeId,
      insertNodeOnPort,
      nodes,
      pendingBoundaryPort,
      selectedLinkPortsByNode,
      selectedBoundaryPort,
      commitNodeExpression,
      updateBoundaryPortName,
      updateBoundaryPortOrder,
      updateNodeExpression,
      updateNodeId,
      updateNodeParam,
      updateNodeType,
    ],
  );

  const edgesWithCallbacks = useMemo(
    () => {
      const selectedEdgeCount = edges.filter((edge) => edge.selected).length;

      return edges.map((edge) => ({
        ...edge,
        reconnectable: edge.selected === true,
        data: {
          ...edge.data,
          weight: edge.data?.weight ?? 1,
          mode: edge.data?.mode ?? 'set',
          onWeightChange: updateEdgeWeight,
          onModeChange: updateEdgeMode,
          onInsertNode: insertNodeOnEdge,
          showLinkControls: edge.selected === true && selectedEdgeCount === 1,
        },
      }));
    },
    [edges, insertNodeOnEdge, updateEdgeMode, updateEdgeWeight],
  );

  const materializedGraph = useMemo(
    () => materializeRootGraph(nodesWithCallbacks, edgesWithCallbacks, editingStack, patchName),
    [edgesWithCallbacks, editingStack, nodesWithCallbacks, patchName],
  );
  const rootPatchName = editingStack[0]?.parentPatchName ?? patchName;
  const isEditingSubpatch = editingStack.length > 0;
  const patch = useMemo(() => patchFromFlow(materializedGraph.nodes, materializedGraph.edges), [materializedGraph]);
  const patchJson = useMemo(() => patchToJson(patch), [patch]);
  const exportedPatchJson = useMemo(() => {
    const patchWithName = { ...patch, name: rootPatchName };
    return patchToJson(patchWithName);
  }, [patch, rootPatchName]);
  const validation = useMemo(() => validatePatch(patch), [patch]);
  const compileResult = useMemo(() => compilePatchToGlsl(patch, 'webgl2', {
    enableScopes: !uiHidden,
  }), [patch, uiHidden]);
  const projectorCompileResult = useMemo(() => compilePatchToGlsl(patch, 'webgl2', {
    enableScopes: false,
  }), [patch]);
  const projectorRevision = useMemo(
    () => renderBundleRevision(`${rootPatchName}\n${patchJson}`),
    [patchJson, rootPatchName],
  );
  const projectorBundle = useMemo(
    () => renderBundleFromCompileResult(projectorCompileResult, rootPatchName, projectorRevision),
    [projectorCompileResult, projectorRevision, rootPatchName],
  );
  useRenderSyncPublisher(projectorBundle);
  const canGroupSelection = useMemo(() => (
    nodes.some((node) => node.selected) &&
    nodes.filter((node) => node.selected).every((node) => node.data.patchNode.type !== null)
  ), [nodes]);
  const feedbackEdgeIds = useMemo(() => new Set(compileResult.feedbackLinkIds), [compileResult.feedbackLinkIds]);
  const displayEdges = useMemo(() => {
    return edgesWithCallbacks.map((edge) => {
      const link = linkFromEdge(edge);
      const className = link && feedbackEdgeIds.has(edgeId(link))
        ? 'shader-edge shader-edge-feedback'
        : 'shader-edge';
      const isFeedback = link ? feedbackEdgeIds.has(edgeId(link)) : false;
      const zIndex = edge.selected ? SELECTED_EDGE_Z_INDEX : undefined;

      if (edge.className === className && edge.data?.isFeedback === isFeedback && edge.zIndex === zIndex) {
        return edge;
      }
      return {
        ...edge,
        className,
        zIndex,
        data: {
          ...edge.data,
          isFeedback,
        },
      };
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
        onPortNameChange: portNameChangePlaceholder,
        onPortMove: portMovePlaceholder,
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
          onPortNameChange: portNameChangePlaceholder,
          onPortMove: portMovePlaceholder,
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
      ...(reconnectPreviewEdge ? [reconnectPreviewEdge] : []),
      ...(duplicateDragPreview?.edges ?? []),
      ...(draftNodePreview ? [draftNodePreview.edge] : []),
    ],
    [displayEdges, draftNodePreview, duplicateDragPreview, reconnectPreviewEdge],
  );
  const translateExtent = useMemo(
    () => getFlowTranslateExtent(nodes, editorSize, viewportForBounds.zoom),
    [editorSize, nodes, viewportForBounds.zoom],
  );
  useEffect(() => {
    saveEditorState(materializedGraph.nodes, materializedGraph.edges, {
      patchName: rootPatchName,
      visualizationVisible,
      sidePanelOpen,
      viewport,
    });
  }, [materializedGraph, rootPatchName, sidePanelOpen, viewport, visualizationVisible]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      reactFlow?.fitView();
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [editingStack.length, reactFlow]);

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
    function updateReconnectDuplicateModifier(event: KeyboardEvent) {
      if (!reconnectingEdgeRef.current) return;
      const duplicateActive = isReconnectDuplicateModifierPressed(event);
      reconnectDuplicateRef.current = duplicateActive;
      setReconnectPreviewEdge(duplicateActive && reconnectPreviewSourceRef.current
        ? reconnectPreviewFromEdge(reconnectPreviewSourceRef.current)
        : null);
    }

    window.addEventListener('keydown', updateReconnectDuplicateModifier);
    window.addEventListener('keyup', updateReconnectDuplicateModifier);
    return () => {
      window.removeEventListener('keydown', updateReconnectDuplicateModifier);
      window.removeEventListener('keyup', updateReconnectDuplicateModifier);
    };
  }, []);

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
      setPendingBoundaryPort(null);
      return;
    }

    const pending = pendingBoundaryPortRef.current;
    if (pending) {
      const isPendingSource = pending.side === 'output'
        && connection.source === pending.nodeId
        && connection.sourceHandle === `out:${pending.port}`;
      const isPendingTarget = pending.side === 'input'
        && connection.target === pending.nodeId
        && connection.targetHandle === `in:${pending.port}`;

      if (isPendingSource || isPendingTarget) {
        materializePendingBoundaryPort(pending);
      }
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
    if (!link) {
      setPendingBoundaryPort(null);
      return;
    }

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
    if (alreadyConnected) {
      setPendingBoundaryPort(null);
      return;
    }

    commitHistory();
    const newEdgeId = edgeId(link);
    setNodes((current) => current.map((node) => ({ ...node, selected: false })));
    setEdges((current) => {
      const nextEdges = addEdge(
        {
          ...candidate,
          id: newEdgeId,
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
        current.map((edge) => ({ ...edge, selected: false })),
      );

      return nextEdges.map((edge) => ({ ...edge, selected: edge.id === newEdgeId }));
    });
    if (edgeSelectionTimeoutRef.current !== null) {
      window.clearTimeout(edgeSelectionTimeoutRef.current);
    }
    edgeSelectionTimeoutRef.current = window.setTimeout(() => {
      setNodes((current) => current.map((node) => ({ ...node, selected: false })));
      setEdges((current) => current.map((edge) => ({ ...edge, selected: edge.id === newEdgeId })));
      edgeSelectionTimeoutRef.current = null;
    }, 0);
    setPendingBoundaryPort(null);
    setSelectedBoundaryPort(null);
  }, [commitHistory, edges, insertNodeOnEdge, materializePendingBoundaryPort, updateEdgeMode, updateEdgeWeight]);

  const onReconnectStart = useCallback((event: ReactMouseEvent, edge: ShaderFlowEdge) => {
    const duplicateActive = isReconnectDuplicateModifierPressed(event);
    reconnectingEdgeRef.current = true;
    reconnectDuplicateRef.current = duplicateActive;
    reconnectPreviewSourceRef.current = edge;
    setReconnectPreviewEdge(duplicateActive ? reconnectPreviewFromEdge(edge) : null);
    updateDraftNodeConnection(null);
    setPendingBoundaryPort(null);
  }, [updateDraftNodeConnection]);

  const onReconnectEnd = useCallback(() => {
    reconnectingEdgeRef.current = false;
    reconnectDuplicateRef.current = false;
    reconnectPreviewSourceRef.current = null;
    setReconnectPreviewEdge(null);
    updateDraftNodeConnection(null);
    setPendingBoundaryPort(null);
  }, [updateDraftNodeConnection]);

  const onReconnect = useCallback((oldEdge: ShaderFlowEdge, connection: Connection) => {
    const candidate: ShaderFlowEdge = {
      ...oldEdge,
      source: connection.source ?? '',
      sourceHandle: connection.sourceHandle,
      target: connection.target ?? '',
      targetHandle: connection.targetHandle,
    };
    const link = linkFromEdge(candidate);
    if (!link) return;

    const oldLink = linkFromEdge(oldEdge);
    const weight = oldEdge.data?.weight ?? oldLink?.weight ?? 1;
    const mode = oldEdge.data?.mode ?? oldLink?.mode ?? 'set';
    const nextEdge: ShaderFlowEdge = {
      ...edgeFromLink({
        from: link.from,
        to: link.to,
        weight,
        mode,
      }),
      selected: true,
      reconnectable: true,
      data: {
        weight,
        mode,
        onWeightChange: updateEdgeWeight,
        onModeChange: updateEdgeMode,
        onInsertNode: insertNodeOnEdge,
      },
    };
    const nextLink = linkFromEdge(nextEdge);
    if (!nextLink) return;
    const nextEdgeId = edgeId(nextLink);
    if (oldEdge.id === nextEdgeId && oldLink && samePatchLink(oldLink, nextLink)) return;

    const shouldDuplicate = reconnectDuplicateRef.current;

    commitHistory();
    setNodes((current) => current.map((node) => ({ ...node, selected: false })));
    setEdges((current) => {
      const duplicate = current.find((edge) => {
        if (edge.id === oldEdge.id) return false;
        const existing = linkFromEdge(edge);
        return existing ? samePatchLink(existing, nextLink) : false;
      });

      if (duplicate) {
        return current
          .filter((edge) => shouldDuplicate || edge.id !== oldEdge.id)
          .map((edge) => ({ ...edge, selected: edge.id === duplicate.id }));
      }

      if (shouldDuplicate) {
        return dedupeEdges([
          ...current.map((edge) => ({ ...edge, selected: false })),
          nextEdge,
        ]);
      }

      return dedupeEdges(current.map((edge) => (
        edge.id === oldEdge.id
          ? nextEdge
          : { ...edge, selected: false }
      )));
    });
    setSelectedBoundaryPort(null);
  }, [commitHistory, insertNodeOnEdge, updateEdgeMode, updateEdgeWeight]);

  const deleteSelectedBoundaryPort = useCallback(() => {
    const selected = selectedBoundaryPort;
    if (!selected) return false;

    const relatedNode = nodesRef.current.find((node) => node.id === selected.nodeId);
    if (!relatedNode || !canRenameBoundaryPort(relatedNode.data.patchNode as PatchNode, selected.side)) return false;

    commitHistory();
    setNodes((current) => current.map((node) => {
      if (node.id !== selected.nodeId) return node;

      const nextInputs = selected.side === 'input'
        ? (node.data.patchNode.inputs ?? []).filter((port) => port.name !== selected.port)
        : node.data.patchNode.inputs;
      const nextOutputs = selected.side === 'output'
        ? (node.data.patchNode.outputs ?? []).filter((port) => port.name !== selected.port)
        : node.data.patchNode.outputs;
      const nextParams = selected.side === 'input'
        ? Object.fromEntries(Object.entries(node.data.patchNode.params).filter(([key]) => key !== selected.port))
        : node.data.patchNode.params;

      return {
        ...node,
        data: {
          ...node.data,
          patchNode: {
            ...node.data.patchNode,
            params: nextParams,
            ...(nextInputs ? { inputs: nextInputs } : {}),
            ...(nextOutputs ? { outputs: nextOutputs } : {}),
          },
        },
      };
    }));
    setEdges((current) => dedupeEdges(current.filter((edge) => {
      const link = linkFromEdge(edge);
      if (!link) return true;

      if (selected.side === 'input') {
        return !(link.to.node === selected.nodeId && link.to.port === selected.port);
      }

      return !(link.from.node === selected.nodeId && link.from.port === selected.port);
    })));

    const frame = editingStack[editingStack.length - 1];
    if (frame) {
      setEditingStack((current) => current.map((entry, index) => {
        if (index !== current.length - 1) return entry;

        const parentEdges = dedupeEdges(entry.parentEdges.filter((edge) => {
          const link = linkFromEdge(edge);
          if (!link) return true;

          if (relatedNode.data.patchNode.type === 'Ins' && selected.side === 'output') {
            return !(link.to.node === entry.groupId && link.to.port === selected.port);
          }

          if (relatedNode.data.patchNode.type === 'Outs' && selected.side === 'input') {
            return !(link.from.node === entry.groupId && link.from.port === selected.port);
          }

          return true;
        }));

        const parentNodes = entry.parentNodes.map((node) => {
          if (node.id !== entry.groupId) return node;

          if (relatedNode.data.patchNode.type === 'Ins' && selected.side === 'output') {
            return {
              ...node,
              data: {
                ...node.data,
                patchNode: {
                  ...node.data.patchNode,
                  params: Object.fromEntries(Object.entries(node.data.patchNode.params).filter(([key]) => key !== selected.port)),
                  inputs: (node.data.patchNode.inputs ?? []).filter((port) => port.name !== selected.port),
                },
              },
            };
          }

          if (relatedNode.data.patchNode.type === 'Outs' && selected.side === 'input') {
            return {
              ...node,
              data: {
                ...node.data,
                patchNode: {
                  ...node.data.patchNode,
                  outputs: (node.data.patchNode.outputs ?? []).filter((port) => port.name !== selected.port),
                },
              },
            };
          }

          return node;
        });

        return {
          ...entry,
          parentEdges,
          parentNodes,
        };
      }));
    }

    setPendingBoundaryPort((current) => (
      current && current.nodeId === selected.nodeId && current.side === selected.side && current.port === selected.port
        ? null
        : current
    ));
    setSelectedBoundaryPort(null);
    return true;
  }, [commitHistory, editingStack, selectedBoundaryPort]);

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
            onPortNameChange: updateBoundaryPortName,
            onPortMove: updateBoundaryPortOrder,
            isTypePickerOpen: true,
          },
        },
      ]);
      setEditingTypeNodeId(id);
    },
    [commitHistory, insertNodeOnPort, nodes, reactFlow, updateBoundaryPortName, updateBoundaryPortOrder, updateNodeId, updateNodeParam, updateNodeType],
  );

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }

    void document.documentElement.requestFullscreen();
  }, []);

  const fitGraphToView = useCallback(() => {
    if (!reactFlow) return;

    window.setTimeout(() => {
      void reactFlow.fitView({ padding: 0.2 }).then(() => {
        const nextViewport = reactFlow.getViewport();
        setViewportForBounds(nextViewport);
        setViewport(nextViewport);
      });
    }, 0);
  }, [reactFlow]);

  useEffect(() => {
    const handleAppShortcutKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || isEditableEventTarget(event.target)) return;

      const hasModifier = event.metaKey || event.ctrlKey;
      if (!hasModifier || event.altKey) return;

      const key = event.key.toLowerCase();
      if (key === 'u') {
        event.preventDefault();
        event.stopPropagation();
        setUiHidden((current) => !current);
        return;
      }

      if (key === 'f' && event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        toggleFullscreen();
        return;
      }

      if (key === 's' && event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        setVisualizationVisible((visible) => !visible);
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
      updateBoundaryPortName,
      updateBoundaryPortOrder,
      null,
    ));
    setEdges(toFlowEdges(loadedPatch, updateEdgeWeight, insertNodeOnEdge));
    setEditingStack([]);
    setEditingTypeNodeId(null);
    setImportError(null);
    if (loadedPatch.name) {
      setPatchName(loadedPatch.name);
    }
    fitGraphToView();
  }, [
    commitHistory,
    fitGraphToView,
    insertNodeOnEdge,
    insertNodeOnPort,
    updateBoundaryPortName,
    updateBoundaryPortOrder,
    updateEdgeWeight,
    updateNodeId,
    updateNodeParam,
    updateNodeType,
  ]);

  const savePatchJson = useCallback(() => {
    const blob = new Blob([exportedPatchJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${sanitizePatchFilename(rootPatchName)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [exportedPatchJson, rootPatchName]);

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

  const newPatch = useCallback(() => {
    if (!window.confirm('Start a new empty patch? Unsaved changes will be lost.')) return;

    const emptyPatch = emptyRootPatch();
    setNodes(toFlowNodes(
      emptyPatch,
      updateNodeParam,
      updateNodeType,
      setEditingTypeNodeId,
      () => setEditingTypeNodeId(null),
      updateNodeId,
      insertNodeOnPort,
      updateBoundaryPortName,
      updateBoundaryPortOrder,
      null,
    ));
    setEdges(toFlowEdges(emptyPatch, updateEdgeWeight, insertNodeOnEdge));
    setEditingStack([]);
    setPatchName('untitled-patch');
    setEditingTypeNodeId(null);
    setPendingBoundaryPort(null);
    setSelectedBoundaryPort(null);
    updateDraftNodeConnection(null);
    updateDuplicateDrag(null);
    setSubpatchImportModal(null);
    setImportError(null);
    copiedGraphRef.current = null;
    pasteCountRef.current = 0;
    historyGroupRef.current = null;
    nodeDragHistoryRef.current = false;
    setHistory({ past: [], future: [] });
    fitGraphToView();
  }, [
    fitGraphToView,
    insertNodeOnEdge,
    insertNodeOnPort,
    updateBoundaryPortName,
    updateBoundaryPortOrder,
    updateDraftNodeConnection,
    updateDuplicateDrag,
    updateEdgeWeight,
    updateNodeId,
    updateNodeParam,
    updateNodeType,
  ]);

  const loadSubpatchImportFile = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;

    try {
      const importedPatch = parsePatchJson(await file.text());
      const candidates = collectSubpatchImportCandidates(importedPatch);
      setSubpatchImportModal({
        fileName: file.name,
        candidates,
        selectedKey: candidates[0]?.key ?? null,
        error: candidates.length === 0 ? 'No subpatches found in this patch.' : null,
      });
      setImportError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSubpatchImportModal({
        fileName: file.name,
        candidates: [],
        selectedKey: null,
        error: message,
      });
      setImportError(message);
    }
  }, []);

  const closeSubpatchImportModal = useCallback(() => {
    setSubpatchImportModal(null);
  }, []);

  const importSubpatchCandidate = useCallback((candidate: ImportedSubpatchCandidate) => {
    const existingIds = new Set(nodesRef.current.map((node) => node.id));
    const id = makeNodeId('Group', existingIds);
    const position = flowPositionForNewImport(reactFlow, editorShellRef.current, nodesRef.current);
    const inputDefinitions = boundaryPortDefinitions(candidate.subpatch, 'Ins', 'outputs');
    const outputDefinitions = boundaryPortDefinitions(candidate.subpatch, 'Outs', 'inputs').map((port) => ({
      name: port.name,
      ...(port.connectable === undefined ? {} : { connectable: port.connectable }),
      ...(port.min === undefined ? {} : { min: port.min }),
      ...(port.max === undefined ? {} : { max: port.max }),
      ...(port.integer === undefined ? {} : { integer: port.integer }),
    }));
    const importedNode: ShaderFlowNode = {
      id,
      type: 'shaderNode',
      position,
      selected: true,
      data: {
        patchNode: {
          id,
          type: 'Group',
          subpatchName: candidate.name,
          subpatchCloneId: makeSubpatchCloneId(id),
          params: Object.fromEntries(inputDefinitions.map((port) => [port.name, port.defaultValue ?? 0])),
          position,
          inputs: inputDefinitions,
          outputs: outputDefinitions,
          subpatch: clonePatch(candidate.subpatch),
        },
        onParamChange: updateParamPlaceholder,
        onTypeChange: updateTypePlaceholder,
        onTypeEditStart: updateTypeEditStartPlaceholder,
        onTypeEditEnd: updateTypeEditEndPlaceholder,
        onIdChange: updateIdPlaceholder,
        onPortDoubleClick: portDoubleClickPlaceholder,
        onPortNameChange: portNameChangePlaceholder,
        onPortMove: portMovePlaceholder,
        isTypePickerOpen: false,
      },
    };

    commitHistory();
    setNodes((current) => [
      ...current.map((node) => ({ ...node, selected: false })),
      importedNode,
    ]);
    setEdges((current) => current.map((edge) => ({ ...edge, selected: false })));
    setEditingTypeNodeId(null);
    setSubpatchImportModal(null);
  }, [commitHistory, reactFlow]);

  const importSelectedSubpatch = useCallback(() => {
    const selectedKey = subpatchImportModal?.selectedKey;
    const candidate = subpatchImportModal?.candidates.find((entry) => entry.key === selectedKey);
    if (!candidate) return;

    importSubpatchCandidate(candidate);
  }, [importSubpatchCandidate, subpatchImportModal]);

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
      updateBoundaryPortName,
      updateBoundaryPortOrder,
      null,
    ));
    setEdges(editorStateToFlowEdges(state, updateEdgeWeight, insertNodeOnEdge));
    setEditingTypeNodeId(null);
  }, [insertNodeOnEdge, insertNodeOnPort, updateBoundaryPortName, updateBoundaryPortOrder, updateEdgeWeight, updateNodeId, updateNodeParam, updateNodeType]);

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
    if (!selectedBoundaryPort) return;

    const node = nodes.find((entry) => entry.id === selectedBoundaryPort.nodeId);
    if (!node) {
      setSelectedBoundaryPort(null);
      return;
    }

    const ports = selectedBoundaryPort.side === 'input'
      ? node.data.patchNode.inputs ?? []
      : node.data.patchNode.outputs ?? [];
    if (!ports.some((port) => port.name === selectedBoundaryPort.port)) {
      setSelectedBoundaryPort(null);
    }
  }, [nodes, selectedBoundaryPort]);

  useEffect(() => {
    if (!selectedBoundaryPort) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest('.port-name-label')) return;
      setSelectedBoundaryPort(null);
    };

    window.addEventListener('pointerdown', handlePointerDown, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, { capture: true });
    };
  }, [selectedBoundaryPort]);

  useEffect(() => {
    const handleBoundaryPortDeleteKeyDown = (event: KeyboardEvent) => {
      if (isEditableEventTarget(event.target)) return;
      if (event.key !== 'Backspace' && event.key !== 'Delete') return;
      if (!deleteSelectedBoundaryPort()) return;

      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener('keydown', handleBoundaryPortDeleteKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleBoundaryPortDeleteKeyDown, { capture: true });
    };
  }, [deleteSelectedBoundaryPort]);

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

      if (key === 'v') {
        event.preventDefault();
        event.stopPropagation();
        void pasteCopiedNodes();
      }
    };

    window.addEventListener('keydown', handleClipboardKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleClipboardKeyDown, { capture: true });
    };
  }, [copySelectedNodes, pasteCopiedNodes]);

  useEffect(() => {
    if (!subpatchImportModal) return;

    const handleImportModalKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setSubpatchImportModal(null);
    };

    window.addEventListener('keydown', handleImportModalKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleImportModalKeyDown, { capture: true });
    };
  }, [subpatchImportModal]);

  const shellClassName = [
    'app-shell',
    sidePanelOpen && !uiHidden ? '' : 'app-shell-panel-closed',
    uiHidden ? 'app-shell-ui-hidden' : '',
    visualizationVisible ? '' : 'app-shell-visual-hidden',
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
        active={visualizationVisible}
        fragmentShader={compileResult.shaderCode}
        feedbackTextureCount={compileResult.feedbackTextureCount}
        shaderArgs={compileResult.shaderArgs}
        bufferSlots={compileResult.bufferSlots}
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
          <input
            className="patch-name-input"
            value={patchName}
            onChange={(event) => setPatchName(event.currentTarget.value)}
            aria-label={isEditingSubpatch ? 'Subpatch name' : 'Patch name'}
            title={isEditingSubpatch ? 'Subpatch name' : 'Patch name'}
            placeholder={isEditingSubpatch ? 'subpatch name' : 'patch name'}
            spellCheck={false}
          />
          {isEditingSubpatch ? (
            <button
              className="viewport-button viewport-button-history"
              type="button"
              onClick={exitSubpatch}
              aria-label="Exit subpatch"
              title="Exit subpatch"
            >
              EX
            </button>
          ) : null}
          <button
            className="viewport-button"
            type="button"
            onClick={() => setVisualizationVisible((visible) => !visible)}
            aria-label={visualizationVisible ? 'Hide visualization' : 'Show visualization'}
            aria-pressed={visualizationVisible}
            title={visualizationVisible ? 'Hide visualization' : 'Show visualization'}
          >
            SH
          </button>
          <button
            className="viewport-button"
            type="button"
            onClick={groupSelectedNodes}
            disabled={!canGroupSelection}
            aria-label="Group selected nodes"
            title="Group selected nodes"
          >
            GR
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
            onClick={newPatch}
            aria-label="New empty patch"
            title="New empty patch"
          >
            NW
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
            onClick={() => fileInputRef.current?.click()}
            aria-label="Load patch JSON"
            title="Load patch JSON"
          >
            LD
          </button>
          <button
            className="viewport-button"
            type="button"
            onClick={() => importFileInputRef.current?.click()}
            aria-label="Import subpatch from patch JSON"
            title="Import subpatch"
          >
            IM
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
          <input
            ref={importFileInputRef}
            className="panel-file-input"
            type="file"
            accept="application/json,.json"
            onChange={loadSubpatchImportFile}
          />
        </div>
        {visualizationVisible ? <div className="fps-counter">{fps} FPS</div> : null}
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
            onNodeDoubleClick={(event, node) => {
              if (!enterGroupNode(node)) return;
              event.preventDefault();
              event.stopPropagation();
            }}
            onEdgeDoubleClick={(event, edge) => {
              event.preventDefault();
              event.stopPropagation();
              insertNodeOnEdge(edge.id);
            }}
            onConnect={onConnect}
            onConnectStart={onConnectStart}
            onConnectEnd={onConnectEnd}
            onReconnect={onReconnect}
            onReconnectStart={onReconnectStart}
            onReconnectEnd={onReconnectEnd}
            reconnectRadius={12}
            onMove={(_, nextViewport) => setViewportForBounds(nextViewport)}
            onMoveEnd={(_, nextViewport) => {
              setViewportForBounds(nextViewport);
              setViewport(nextViewport);
            }}
            connectionMode={ConnectionMode.Loose}
            connectionLineStyle={draftNodePreview ? { stroke: 'transparent' } : undefined}
            translateExtent={translateExtent}
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
            <Controls showInteractive={false} />
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
      {subpatchImportModal ? (
        <div
          className="import-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeSubpatchImportModal();
            }
          }}
        >
          <section
            className="import-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-modal-title"
          >
            <header className="import-modal-header">
              <div>
                <h2 id="import-modal-title">Import subpatch</h2>
                <p>{subpatchImportModal.fileName}</p>
              </div>
              <button
                className="import-modal-close"
                type="button"
                onClick={closeSubpatchImportModal}
                aria-label="Close import modal"
                title="Close"
              >
                X
              </button>
            </header>
            {subpatchImportModal.error ? (
              <p className="import-modal-message error">{subpatchImportModal.error}</p>
            ) : (
              <div className="import-subpatch-list" role="listbox" aria-label="Subpatches">
                {subpatchImportModal.candidates.map((candidate) => (
                  <button
                    className={[
                      'import-subpatch-option',
                      candidate.key === subpatchImportModal.selectedKey ? 'import-subpatch-option-selected' : '',
                    ].filter(Boolean).join(' ')}
                    key={candidate.key}
                    type="button"
                    role="option"
                    aria-selected={candidate.key === subpatchImportModal.selectedKey}
                    onClick={() => {
                      setSubpatchImportModal((current) => current ? {
                        ...current,
                        selectedKey: candidate.key,
                      } : current);
                    }}
                    onDoubleClick={() => importSubpatchCandidate(candidate)}
                  >
                    <span className="import-subpatch-name">{candidate.name}</span>
                    <span className="import-subpatch-path">{candidate.path}</span>
                    <span className="import-subpatch-meta">
                      {candidate.inputCount} in / {candidate.outputCount} out / {candidate.nodeCount} nodes
                    </span>
                  </button>
                ))}
              </div>
            )}
            <footer className="import-modal-actions">
              <button type="button" onClick={closeSubpatchImportModal}>Cancel</button>
              <button
                type="button"
                onClick={importSelectedSubpatch}
                disabled={!subpatchImportModal.selectedKey || subpatchImportModal.candidates.length === 0}
              >
                Import
              </button>
            </footer>
          </section>
        </div>
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

function portNameChangePlaceholder() {
  // Replaced after React state exists.
}

function portMovePlaceholder() {
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

function reconnectPreviewFromEdge(edge: ShaderFlowEdge): ShaderFlowEdge {
  return {
    ...edge,
    id: `reconnect-preview:${edge.id}`,
    selected: false,
    selectable: false,
    deletable: false,
    reconnectable: false,
    className: [edge.className ?? 'shader-edge', 'shader-edge-reconnect-preview'].filter(Boolean).join(' '),
    data: {
      weight: edge.data?.weight ?? 1,
      mode: edge.data?.mode ?? 'set',
      onWeightChange: edge.data?.onWeightChange ?? updateEdgeWeightPlaceholder,
      onModeChange: edge.data?.onModeChange ?? updateEdgeModePlaceholder,
      onInsertNode: edge.data?.onInsertNode ?? updateEdgeInsertPlaceholder,
      isFeedback: edge.data?.isFeedback,
      showLinkControls: false,
    },
  };
}

function materializeRootGraph(
  activeNodes: ShaderFlowNode[],
  activeEdges: ShaderFlowEdge[],
  editingStack: SubpatchEditFrame[],
  activePatchName: string,
): { nodes: ShaderFlowNode[]; edges: ShaderFlowEdge[] } {
  if (editingStack.length === 0) {
    return { nodes: activeNodes, edges: activeEdges };
  }

  let subpatch = patchFromFlow(activeNodes, activeEdges);
  let requestedGroupName = activePatchName;
  let materialized: { nodes: ShaderFlowNode[]; edges: ShaderFlowEdge[] } | null = null;

  for (let index = editingStack.length - 1; index >= 0; index -= 1) {
    const frame = editingStack[index];
    materialized = applySubpatchToParent(frame, subpatch, requestedGroupName);
    subpatch = patchFromFlow(materialized.nodes, materialized.edges);
    requestedGroupName = frame.parentPatchName;
  }

  return materialized ?? { nodes: activeNodes, edges: activeEdges };
}

function applySubpatchToParent(
  frame: SubpatchEditFrame,
  subpatch: Patch,
  requestedGroupName: string,
): { nodes: ShaderFlowNode[]; edges: ShaderFlowEdge[] } {
  const inputDefinitions = boundaryPortDefinitions(subpatch, 'Ins', 'outputs');
  const outputDefinitions = boundaryPortDefinitions(subpatch, 'Outs', 'inputs').map((port) => ({
    name: port.name,
    ...(port.connectable === undefined ? {} : { connectable: port.connectable }),
    ...(port.min === undefined ? {} : { min: port.min }),
    ...(port.max === undefined ? {} : { max: port.max }),
    ...(port.integer === undefined ? {} : { integer: port.integer }),
  }));
  const groupNode = frame.parentNodes.find((node) => node.id === frame.groupId);
  const cloneId = groupNode?.data.patchNode.subpatchCloneId;
  const linkedGroupIds = new Set(
    frame.parentNodes
      .filter((node) => (
        node.data.patchNode.type === 'Group' &&
        cloneId !== undefined &&
        node.data.patchNode.subpatchCloneId === cloneId
      ))
      .map((node) => node.id),
  );
  linkedGroupIds.add(frame.groupId);
  const nextSubpatchName = normalizeSubpatchName(requestedGroupName, groupNode?.data.patchNode.subpatchName ?? frame.groupId);
  const inputNames = new Set(inputDefinitions.map((port) => port.name));
  const outputNames = new Set(outputDefinitions.map((port) => port.name));
  const nodes: ShaderFlowNode[] = frame.parentNodes.map((node) => {
    if (!linkedGroupIds.has(node.id)) return { ...node, selected: false };

    const previousParams = node.data.patchNode.params;
    const params = Object.fromEntries(inputDefinitions.map((port) => [
      port.name,
      previousParams[port.name] ?? port.defaultValue ?? 0,
    ]));

    return {
      ...node,
      selected: node.id === frame.groupId,
      data: {
        ...node.data,
        patchNode: {
          ...node.data.patchNode,
          id: node.id,
          type: 'Group' as const,
          subpatchName: nextSubpatchName,
          subpatchCloneId: node.data.patchNode.subpatchCloneId ?? cloneId,
          params,
          inputs: inputDefinitions,
          outputs: outputDefinitions,
          subpatch: clonePatch(subpatch),
        },
      },
    };
  });

  if (!groupNode) {
    return { nodes: frame.parentNodes, edges: frame.parentEdges };
  }

  const edges = dedupeEdges(frame.parentEdges.flatMap((edge) => {
    const link = linkFromEdge(edge);
    if (!link) return [];

    if (linkedGroupIds.has(link.to.node) && !inputNames.has(link.to.port)) {
      return [];
    }
    if (linkedGroupIds.has(link.from.node) && !outputNames.has(link.from.port)) {
      return [];
    }

    return [{ ...edge, selected: false }];
  }));

  return { nodes, edges };
}

function collectSubpatchImportCandidates(patch: Patch): ImportedSubpatchCandidate[] {
  const candidates: ImportedSubpatchCandidate[] = [];

  function visit(currentPatch: Patch, pathParts: string[]) {
    currentPatch.nodes.forEach((node, index) => {
      if (node.type !== 'Group' || !node.subpatch) return;

      const name = node.subpatchName ?? node.id;
      const path = [...pathParts, name];
      const inputCount = boundaryPortDefinitions(node.subpatch, 'Ins', 'outputs').length;
      const outputCount = boundaryPortDefinitions(node.subpatch, 'Outs', 'inputs').length;
      candidates.push({
        key: `${path.join('/')}:${node.id}:${index}`,
        name,
        path: path.join(' / '),
        sourceNodeId: node.id,
        subpatch: node.subpatch,
        inputCount,
        outputCount,
        nodeCount: node.subpatch.nodes.length,
      });

      visit(node.subpatch, path);
    });
  }

  visit(patch, []);
  return candidates;
}

function flowPositionForNewImport(
  reactFlow: ReactFlowInstance<ShaderFlowNode, ShaderFlowEdge> | null,
  editorShell: HTMLElement | null,
  nodes: ShaderFlowNode[],
): { x: number; y: number } {
  if (reactFlow && editorShell) {
    const rect = editorShell.getBoundingClientRect();
    return reactFlow.screenToFlowPosition({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
  }

  if (nodes.length > 0) {
    const bounds = nodeBounds(nodes);
    return {
      x: bounds.x + bounds.width + PASTE_OFFSET.x,
      y: bounds.y,
    };
  }

  return { x: 0, y: 0 };
}

function emptyRootPatch(): Patch {
  return {
    nodes: [
      {
        id: 'system_1',
        type: 'System',
        params: {},
        position: { x: 40, y: 160 },
      },
      {
        id: 'output_1',
        type: 'Output',
        params: defaultParamsFor('Output'),
        position: { x: 360, y: 160 },
      },
    ],
    links: [],
  };
}

function emptySubpatchForGroup(groupNode: PatchNode, position: { x: number; y: number }): Patch {
  return {
    nodes: [
      {
        id: 'ins_1',
        type: 'Ins',
        params: {},
        outputs: groupNode.inputs?.map((port) => ({ ...port })) ?? [],
        position: { x: position.x - 220, y: position.y },
      },
      {
        id: 'outs_1',
        type: 'Outs',
        params: Object.fromEntries((groupNode.outputs ?? []).map((port) => [port.name, 0])),
        inputs: groupNode.outputs?.map((port) => ({ ...port, defaultValue: port.defaultValue ?? 0 })) ?? [],
        position: { x: position.x + 220, y: position.y },
      },
    ],
    links: [],
  };
}

function boundaryPortDefinitions(
  patch: Patch,
  boundaryType: 'Ins' | 'Outs',
  side: 'inputs' | 'outputs',
): PortDefinition[] {
  const usedNames = new Set<string>();
  const definitions: PortDefinition[] = [];

  for (const node of patch.nodes) {
    if (node.type !== boundaryType) continue;

    for (const port of node[side] ?? []) {
      if (usedNames.has(port.name)) continue;

      usedNames.add(port.name);
      definitions.push({ ...port });
    }
  }

  return definitions;
}

function groupSelectedGraph(nodes: ShaderFlowNode[], edges: ShaderFlowEdge[]): { nodes: ShaderFlowNode[]; edges: ShaderFlowEdge[] } | null {
  const selectedNodes = nodes.filter((node) => node.selected);
  if (selectedNodes.length === 0 || selectedNodes.some((node) => node.data.patchNode.type === null)) {
    return null;
  }

  const selectedNodeIds = new Set(selectedNodes.map((node) => node.id));
  const existingIds = new Set(nodes.map((node) => node.id));
  const groupId = makeNodeId('Group', existingIds);
  const bounds = nodeBounds(selectedNodes);
  const groupPosition = { x: bounds.x, y: bounds.y };
  const linkedEdges = edges
    .map((edge, index) => ({ edge, link: linkFromEdge(edge), index }))
    .filter((entry): entry is { edge: ShaderFlowEdge; link: NonNullable<ReturnType<typeof linkFromEdge>>; index: number } => (
      entry.link !== null
    ));
  const incomingBoundary = linkedEdges.filter(({ link }) => !selectedNodeIds.has(link.from.node) && selectedNodeIds.has(link.to.node));
  const outgoingBoundary = linkedEdges.filter(({ link }) => selectedNodeIds.has(link.from.node) && !selectedNodeIds.has(link.to.node));
  const internalEdges = linkedEdges.filter(({ link }) => selectedNodeIds.has(link.from.node) && selectedNodeIds.has(link.to.node));
  const inputPorts = boundaryPorts(
    incomingBoundary,
    (link) => link.to,
    (endpoint) => endpoint.port,
  );
  const outputPorts = boundaryPorts(
    outgoingBoundary,
    (link) => link.from,
    (endpoint) => endpoint.port,
  );
  const inputDefinitions = inputPorts.map(({ name }): PortDefinition => ({ name, defaultValue: 0 }));
  const outputDefinitions = outputPorts.map(({ name }): PortDefinition => ({ name }));
  const inputNameByEndpoint = new Map(inputPorts.map((port) => [endpointKey(port.endpoint), port.name]));
  const outputNameByEndpoint = new Map(outputPorts.map((port) => [endpointKey(port.endpoint), port.name]));
  const subpatch: Patch = {
    nodes: [
      {
        id: 'ins_1',
        type: 'Ins',
        params: {},
        outputs: inputDefinitions,
        position: { x: bounds.x - 220, y: bounds.y },
      },
      ...selectedNodes.map((node) => patchNodeFromFlowNode(node)),
      {
        id: 'outs_1',
        type: 'Outs',
        params: Object.fromEntries(outputDefinitions.map((port) => [port.name, 0])),
        inputs: outputDefinitions.map((port) => ({ ...port, defaultValue: 0 })),
        position: { x: bounds.x + bounds.width + 220, y: bounds.y },
      },
    ],
    links: dedupePatchLinks([
      ...internalEdges.map(({ link }) => link),
      ...incomingBoundary.flatMap(({ link }) => {
        const port = inputNameByEndpoint.get(endpointKey(link.to));
        return port ? [{ from: { node: 'ins_1', port }, to: link.to }] : [];
      }),
      ...outgoingBoundary.flatMap(({ link }) => {
        const port = outputNameByEndpoint.get(endpointKey(link.from));
        return port ? [{ from: link.from, to: { node: 'outs_1', port } }] : [];
      }),
    ]),
  };
  const groupNode: ShaderFlowNode = {
    id: groupId,
    type: 'shaderNode',
    position: groupPosition,
    selected: true,
    data: {
      patchNode: {
        id: groupId,
        type: 'Group',
        subpatchName: groupId,
        subpatchCloneId: makeSubpatchCloneId(groupId),
        params: Object.fromEntries(inputDefinitions.map((port) => [port.name, 0])),
        position: groupPosition,
        inputs: inputDefinitions,
        outputs: outputDefinitions,
        subpatch,
      },
      onParamChange: updateParamPlaceholder,
      onTypeChange: updateTypePlaceholder,
      onTypeEditStart: updateTypeEditStartPlaceholder,
      onTypeEditEnd: updateTypeEditEndPlaceholder,
      onIdChange: updateIdPlaceholder,
      onPortDoubleClick: portDoubleClickPlaceholder,
      onPortNameChange: portNameChangePlaceholder,
      onPortMove: portMovePlaceholder,
      isTypePickerOpen: false,
    },
  };
  const rewiredEdges = linkedEdges.flatMap(({ edge, link }) => {
    const sourceSelected = selectedNodeIds.has(link.from.node);
    const targetSelected = selectedNodeIds.has(link.to.node);
    if (sourceSelected && targetSelected) return [];

    if (!sourceSelected && targetSelected) {
      const port = inputNameByEndpoint.get(endpointKey(link.to));
      return port
        ? [edgeFromLink({ from: link.from, to: { node: groupId, port }, weight: link.weight, mode: link.mode })]
        : [];
    }

    if (sourceSelected && !targetSelected) {
      const port = outputNameByEndpoint.get(endpointKey(link.from));
      return port
        ? [edgeFromLink({ from: { node: groupId, port }, to: link.to, weight: link.weight, mode: link.mode })]
        : [];
    }

    return [edge];
  });

  return {
    nodes: [
      ...nodes
        .filter((node) => !selectedNodeIds.has(node.id))
        .map((node) => ({ ...node, selected: false })),
      groupNode,
    ],
    edges: dedupeEdges(rewiredEdges.map((edge) => ({ ...edge, selected: false }))),
  };
}

function patchNodeFromFlowNode(node: ShaderFlowNode): PatchNode {
  const patchNode = node.data.patchNode;
  if (patchNode.type === null) {
    throw new Error(`Cannot group draft node "${node.id}".`);
  }

  return {
    id: patchNode.id,
    type: patchNode.type,
    ...(patchNode.subpatchName ? { subpatchName: patchNode.subpatchName } : {}),
    ...(patchNode.subpatchCloneId ? { subpatchCloneId: patchNode.subpatchCloneId } : {}),
    ...(patchNode.expression !== undefined ? { expression: patchNode.expression } : {}),
    params: { ...patchNode.params },
    position: { ...node.position },
    ...(patchNode.inputs ? { inputs: patchNode.inputs.map((port) => ({ ...port })) } : {}),
    ...(patchNode.outputs ? { outputs: patchNode.outputs.map((port) => ({ ...port })) } : {}),
    ...(patchNode.subpatch ? { subpatch: clonePatch(patchNode.subpatch) } : {}),
  };
}

function clonePatch(patch: Patch): Patch {
  return {
    nodes: patch.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      ...(node.subpatchName ? { subpatchName: node.subpatchName } : {}),
      ...(node.subpatchCloneId ? { subpatchCloneId: node.subpatchCloneId } : {}),
      ...(node.expression !== undefined ? { expression: node.expression } : {}),
      params: { ...node.params },
      ...(node.position ? { position: { ...node.position } } : {}),
      ...(node.inputs ? { inputs: node.inputs.map((port) => ({ ...port })) } : {}),
      ...(node.outputs ? { outputs: node.outputs.map((port) => ({ ...port })) } : {}),
      ...(node.subpatch ? { subpatch: clonePatch(node.subpatch) } : {}),
    })),
    links: patch.links.map((link) => ({
      from: { ...link.from },
      to: { ...link.to },
      weight: link.weight,
      mode: link.mode,
    })),
  };
}

function boundaryPorts(
  entries: Array<{ link: NonNullable<ReturnType<typeof linkFromEdge>>; index: number }>,
  endpointForLink: (link: NonNullable<ReturnType<typeof linkFromEdge>>) => PatchLink['from'],
  baseNameForEndpoint: (endpoint: PatchLink['from']) => string,
): Array<{ endpoint: PatchLink['from']; name: string }> {
  const ports: Array<{ endpoint: PatchLink['from']; name: string; index: number }> = [];
  const usedNames = new Set<string>();
  const endpointNames = new Map<string, string>();

  for (const entry of entries) {
    const endpoint = endpointForLink(entry.link);
    const key = endpointKey(endpoint);
    const existingName = endpointNames.get(key);
    if (existingName) continue;

    const preferredName = normalizePortName(baseNameForEndpoint(endpoint)) || 'value';
    const fallbackName = normalizePortName(`${endpoint.node}_${endpoint.port}`) || preferredName;
    const name = uniquePortName(usedNames.has(preferredName) ? fallbackName : preferredName, usedNames);
    usedNames.add(name);
    endpointNames.set(key, name);
    ports.push({ endpoint, name, index: entry.index });
  }

  return ports.sort((a, b) => a.index - b.index).map(({ endpoint, name }) => ({ endpoint, name }));
}

function nodeBounds(nodes: ShaderFlowNode[]): { x: number; y: number; width: number; height: number } {
  const xs = nodes.map((node) => node.position.x);
  const ys = nodes.map((node) => node.position.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function endpointKey(endpoint: PatchLink['from']): string {
  return `${endpoint.node}.${endpoint.port}`;
}

function canRenameBoundaryPort(node: PatchNode, side: 'input' | 'output'): boolean {
  return (node.type === 'Ins' && side === 'output') || (node.type === 'Outs' && side === 'input');
}

function renamePortDefinitions(
  ports: PortDefinition[] | undefined,
  previousPort: string,
  nextPort: string,
): PortDefinition[] | undefined {
  return ports?.map((port) => port.name === previousPort ? { ...port, name: nextPort } : port);
}

function movePortDefinitions(
  ports: PortDefinition[] | undefined,
  portName: string,
  direction: -1 | 1,
): PortDefinition[] | undefined {
  if (!ports) return ports;

  const fromIndex = ports.findIndex((port) => port.name === portName);
  const toIndex = fromIndex + direction;
  if (fromIndex < 0 || toIndex < 0 || toIndex >= ports.length) return ports;

  const nextPorts = ports.map((port) => ({ ...port }));
  [nextPorts[fromIndex], nextPorts[toIndex]] = [nextPorts[toIndex], nextPorts[fromIndex]];
  return nextPorts;
}

function renameParamKey(params: Record<string, number>, previousKey: string, nextKey: string): Record<string, number> {
  if (previousKey === nextKey || params[previousKey] === undefined) return params;

  const nextParams = { ...params, [nextKey]: params[previousKey] };
  delete nextParams[previousKey];
  return nextParams;
}

function renameEdgePort(
  edge: ShaderFlowEdge,
  nodeId: string,
  side: 'input' | 'output',
  previousPort: string,
  nextPort: string,
): ShaderFlowEdge {
  const link = linkFromEdge(edge);
  if (!link) return edge;

  if (side === 'input' && link.to.node === nodeId && link.to.port === previousPort) {
    return {
      ...edgeFromLink({
        from: link.from,
        to: { node: nodeId, port: nextPort },
        weight: link.weight,
        mode: link.mode,
      }),
      selected: edge.selected,
    };
  }

  if (side === 'output' && link.from.node === nodeId && link.from.port === previousPort) {
    return {
      ...edgeFromLink({
        from: { node: nodeId, port: nextPort },
        to: link.to,
        weight: link.weight,
        mode: link.mode,
      }),
      selected: edge.selected,
    };
  }

  return edge;
}

function renameGroupBoundaryEdgePort(
  edge: ShaderFlowEdge,
  groupId: string,
  side: 'input' | 'output',
  previousPort: string,
  nextPort: string,
): ShaderFlowEdge {
  return renameEdgePort(edge, groupId, side, previousPort, nextPort);
}

function normalizePortName(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[-_]+|[-_]+$/g, '');
}

function uniqueBoundaryPortName(requestedPort: string, currentPort: string, ports: string[]): string | null {
  const normalized = normalizePortName(requestedPort);
  if (!normalized) return null;
  if (normalized === currentPort) return currentPort;

  const usedNames = new Set(ports);
  usedNames.delete(currentPort);
  return uniquePortName(normalized, usedNames);
}

function uniquePortName(baseName: string, usedNames: Set<string>): string {
  if (!usedNames.has(baseName)) return baseName;

  let index = 2;
  let candidate = `${baseName}_${index}`;
  while (usedNames.has(candidate)) {
    index += 1;
    candidate = `${baseName}_${index}`;
  }

  return candidate;
}

function dedupePatchLinks(links: PatchLink[]): PatchLink[] {
  const seen = new Set<string>();
  const deduped: PatchLink[] = [];

  for (const link of links) {
    const key = `${link.from.node}:${link.from.port}->${link.to.node}:${link.to.port}`;
    if (seen.has(key)) continue;

    seen.add(key);
    deduped.push(link);
  }

  return deduped;
}

function selectedGraphFromNodes(nodes: ShaderFlowNode[], edges: ShaderFlowEdge[]): CopiedGraph | null {
  const selectedNodeIds = new Set(nodes.filter((node) => node.selected).map((node) => node.id));
  if (selectedNodeIds.size === 0) return null;

  return graphForNodeIds(nodes, edges, selectedNodeIds);
}

async function writeCopiedGraphToClipboard(graph: CopiedGraph): Promise<void> {
  if (!navigator.clipboard?.writeText) return;

  try {
    await navigator.clipboard.writeText(JSON.stringify(copiedGraphToClipboardPayload(graph), null, 2));
  } catch {
    // Clipboard permission can be denied; the in-memory clipboard remains available.
  }
}

async function readCopiedGraphFromClipboard(): Promise<CopiedGraph | null> {
  if (!navigator.clipboard?.readText) return null;

  try {
    return copiedGraphFromClipboardText(await navigator.clipboard.readText());
  } catch {
    return null;
  }
}

function copiedGraphToClipboardPayload(graph: CopiedGraph): CopiedGraphClipboardPayload {
  return {
    app: 'visual-visual',
    kind: 'copied-graph',
    version: 1,
    graph: {
      nodes: flowToEditorState(graph.nodes, graph.edges).nodes,
      edges: flowToEditorState(graph.nodes, graph.edges).edges,
      boundaryEdges: flowToEditorState(graph.nodes, graph.boundaryEdges).edges,
    },
  };
}

function copiedGraphFromClipboardText(text: string): CopiedGraph | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!isCopiedGraphClipboardPayload(parsed)) return null;

  const state: PersistedEditorState = {
    version: 1,
    nodes: parsed.graph.nodes,
    edges: parsed.graph.edges,
  };
  const boundaryState: PersistedEditorState = {
    version: 1,
    nodes: parsed.graph.nodes,
    edges: parsed.graph.boundaryEdges,
  };

  try {
    return {
      nodes: editorStateToFlowNodes(
        state,
        updateParamPlaceholder,
        updateTypePlaceholder,
        updateTypeEditStartPlaceholder,
        updateTypeEditEndPlaceholder,
        updateIdPlaceholder,
        portDoubleClickPlaceholder,
        portNameChangePlaceholder,
        portMovePlaceholder,
        null,
      ).map(cloneFlowNodeSnapshot),
      edges: editorStateToFlowEdges(state, updateEdgeWeightPlaceholder).map(cloneFlowEdgeSnapshot),
      boundaryEdges: editorStateToFlowEdges(boundaryState, updateEdgeWeightPlaceholder).map(cloneFlowEdgeSnapshot),
    };
  } catch {
    return null;
  }
}

function isCopiedGraphClipboardPayload(value: unknown): value is CopiedGraphClipboardPayload {
  if (!isRecord(value)) return false;
  if (value.app !== 'visual-visual' || value.kind !== 'copied-graph' || value.version !== 1) return false;
  if (!isRecord(value.graph)) return false;

  return (
    Array.isArray(value.graph.nodes) &&
    Array.isArray(value.graph.edges) &&
    Array.isArray(value.graph.boundaryEdges)
  );
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

function applySourceSubpatchCloneIds(
  nodes: ShaderFlowNode[],
  sourceSubpatchCloneIds: Record<string, string>,
): ShaderFlowNode[] {
  if (Object.keys(sourceSubpatchCloneIds).length === 0) return nodes;

  return nodes.map((node) => {
    const cloneId = sourceSubpatchCloneIds[node.id];
    if (!cloneId) return node;
    if (node.data.patchNode.subpatchCloneId === cloneId) return node;

    return {
      ...node,
      data: {
        ...node.data,
        patchNode: {
          ...node.data.patchNode,
          subpatchCloneId: cloneId,
          ...(node.data.patchNode.type === 'Group' && !node.data.patchNode.subpatchName
            ? { subpatchName: node.id }
            : {}),
        },
      },
    };
  });
}

function normalizeSubpatchName(requestedName: string, fallback: string): string {
  const trimmed = requestedName.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function makeSubpatchCloneId(seed: string): string {
  subpatchCloneSequence += 1;
  const normalizedSeed = seed.replace(/[^A-Za-z0-9_-]/g, '_') || 'group';
  return `subpatch_clone_${normalizedSeed}_${subpatchCloneSequence}`;
}

function duplicateGraph(
  graph: CopiedGraph,
  existingNodes: ShaderFlowNode[],
  positionForNode: (node: ShaderFlowNode) => { x: number; y: number },
  options: { includeBoundaryEdges?: boolean } = {},
): DuplicateGraphResult {
  const existingIds = new Set(existingNodes.map((node) => node.id));
  const idMap = new Map<string, string>();
  const sourceSubpatchCloneIds: Record<string, string> = {};
  const nodes = graph.nodes.map((node): ShaderFlowNode => {
    const type = node.data.patchNode.type ?? 'node';
    const id = makeNodeId(type, existingIds);
    const position = positionForNode(node);
    const subpatchName = node.data.patchNode.subpatch
      ? (node.data.patchNode.subpatchName ?? node.id)
      : node.data.patchNode.subpatchName;
    const subpatchCloneId = node.data.patchNode.subpatch
      ? (node.data.patchNode.subpatchCloneId ?? makeSubpatchCloneId(node.id))
      : undefined;

    if (subpatchCloneId && !node.data.patchNode.subpatchCloneId) {
      sourceSubpatchCloneIds[node.id] = subpatchCloneId;
    }

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
          ...(subpatchName ? { subpatchName } : {}),
          ...(subpatchCloneId ? { subpatchCloneId } : {}),
          ...(node.data.patchNode.expression !== undefined ? { expression: node.data.patchNode.expression } : {}),
          params: { ...node.data.patchNode.params },
          position,
          ...(node.data.patchNode.inputs ? { inputs: node.data.patchNode.inputs.map((port) => ({ ...port })) } : {}),
          ...(node.data.patchNode.outputs ? { outputs: node.data.patchNode.outputs.map((port) => ({ ...port })) } : {}),
          ...(node.data.patchNode.subpatch ? { subpatch: clonePatch(node.data.patchNode.subpatch) } : {}),
        },
        onParamChange: updateParamPlaceholder,
        onTypeChange: updateTypePlaceholder,
        onTypeEditStart: updateTypeEditStartPlaceholder,
        onTypeEditEnd: updateTypeEditEndPlaceholder,
        onIdChange: updateIdPlaceholder,
        onPortDoubleClick: portDoubleClickPlaceholder,
        onPortNameChange: portNameChangePlaceholder,
        onPortMove: portMovePlaceholder,
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

  return { nodes, edges, boundaryEdges: [], sourceSubpatchCloneIds };
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
        ...(node.data.patchNode.expression !== undefined ? { expression: node.data.patchNode.expression } : {}),
        ...(node.data.patchNode.inputs ? { inputs: node.data.patchNode.inputs.map((port) => ({ ...port })) } : {}),
        ...(node.data.patchNode.outputs ? { outputs: node.data.patchNode.outputs.map((port) => ({ ...port })) } : {}),
        ...(node.data.patchNode.subpatch ? { subpatch: clonePatch(node.data.patchNode.subpatch) } : {}),
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

function getFlowTranslateExtent(
  nodes: ShaderFlowNode[],
  editorSize: EditorSize,
  zoom: number,
): CoordinateExtent {
  if (editorSize.width <= 0 || editorSize.height <= 0) {
    return FLOW_INFINITE_EXTENT;
  }

  const visibleNodes = nodes.filter((node) => !node.hidden);
  const safeZoom = Math.max(zoom, 0.01);
  const maxOffscreenX = (editorSize.width * MAX_FLOW_OFFSCREEN_RATIO) / safeZoom;
  const maxOffscreenY = (editorSize.height * MAX_FLOW_OFFSCREEN_RATIO) / safeZoom;

  if (visibleNodes.length === 0) {
    return [
      [-maxOffscreenX, -maxOffscreenY],
      [maxOffscreenX, maxOffscreenY],
    ];
  }

  const bounds = visibleNodes.reduce(
    (current, node) => {
      const width = node.measured?.width ?? node.width ?? node.initialWidth ?? DEFAULT_NODE_BOUNDS.width;
      const height = node.measured?.height ?? node.height ?? node.initialHeight ?? DEFAULT_NODE_BOUNDS.height;
      const left = node.position.x;
      const top = node.position.y;
      const right = left + width;
      const bottom = top + height;

      return {
        minX: Math.min(current.minX, left),
        minY: Math.min(current.minY, top),
        maxX: Math.max(current.maxX, right),
        maxY: Math.max(current.maxY, bottom),
      };
    },
    {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    },
  );

  return [
    [bounds.minX - maxOffscreenX, bounds.minY - maxOffscreenY],
    [bounds.maxX + maxOffscreenX, bounds.maxY + maxOffscreenY],
  ];
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

function isReconnectDuplicateModifierPressed(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return event.metaKey || event.ctrlKey;
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

    const definition = getNodeDefinition(node.data.patchNode as PatchNode);
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

function expressionInputDefinitions(expression: string): PortDefinition[] {
  return extractExpressionInputs(expression).map((name) => ({
    name,
    defaultValue: 0,
  }));
}

function syncParamsToInputs(
  params: Record<string, number>,
  inputs: PortDefinition[],
): Record<string, number> {
  return Object.fromEntries(inputs.map((input) => [
    input.name,
    params[input.name] ?? input.defaultValue ?? 0,
  ]));
}

function samePortDefinitions(left: PortDefinition[], right: PortDefinition[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((port, index) => (
    port.name === right[index]?.name &&
    port.defaultValue === right[index]?.defaultValue &&
    port.connectable === right[index]?.connectable &&
    port.min === right[index]?.min &&
    port.max === right[index]?.max &&
    port.integer === right[index]?.integer
  ));
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
  previousDefinition: NodeDefinition | null,
  nextDefinition: NodeDefinition,
): ShaderFlowEdge | null {
  const link = linkFromEdge(edge);
  if (!link) return null;
  if (link.from.node !== nodeId && link.to.node !== nodeId) return edge;

  if (!previousDefinition) {
    let nextLink = link;

    if (link.from.node === nodeId) {
      const nextPort = nextDefinition.outputs[0]?.name;
      if (!nextPort) return null;
      nextLink = {
        ...nextLink,
        from: { ...nextLink.from, port: nextPort },
      };
    }

    if (link.to.node === nodeId) {
      const nextPort = nextDefinition.inputs.find((input) => input.connectable !== false)?.name;
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
      previousDefinition.outputs.map((port) => port.name),
      nextDefinition.outputs.map((port) => port.name),
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
      previousDefinition.inputs.map((port) => port.name),
      nextDefinition.inputs.map((port) => port.name),
      link.to.port,
    );
    if (!nextPort || !nextDefinition.inputs.some((input) => input.name === nextPort && input.connectable !== false)) return null;
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

function samePatchLink(a: PatchLink, b: PatchLink): boolean {
  return (
    a.from.node === b.from.node &&
    a.from.port === b.from.port &&
    a.to.node === b.to.node &&
    a.to.port === b.to.port
  );
}

function syncEditingStackMidiCcValues(
  editingStack: SubpatchEditFrame[],
  values: MidiCcValueMap,
): SubpatchEditFrame[] {
  let changed = false;
  const nextStack = editingStack.map((frame) => {
    const nextParentNodes = syncNodesWithMidiCcValues(frame.parentNodes, values);
    if (nextParentNodes === frame.parentNodes) {
      return frame;
    }

    changed = true;
    return {
      ...frame,
      parentNodes: nextParentNodes,
    };
  });

  return changed ? nextStack : editingStack;
}

function syncNodesWithMidiCcValues(nodes: ShaderFlowNode[], values: MidiCcValueMap): ShaderFlowNode[] {
  let changed = false;
  const nextNodes = nodes.map((node) => {
    if (node.data.patchNode.type !== 'midiCC') return node;

    const nextParams = syncMidiCcParams(node.data.patchNode.params, values);
    if (nextParams === node.data.patchNode.params) {
      return node;
    }

    changed = true;
    return {
      ...node,
      data: {
        ...node.data,
        patchNode: {
          ...node.data.patchNode,
          params: nextParams,
        },
      },
    };
  });

  return changed ? nextNodes : nodes;
}

function syncMidiCcParams(params: Record<string, number>, values: MidiCcValueMap): Record<string, number> {
  const channel = normalizeMidiChannel(params.channel ?? 1);
  const cc = normalizeMidiCc(params.cc ?? 1);
  const persistedValue = values.get(midiCcKey(channel, cc));
  if (persistedValue === undefined) {
    return params;
  }

  const currentValue = params.value ?? 0;
  if (Math.abs(currentValue - persistedValue) < 0.000001) {
    return params;
  }

  return {
    ...params,
    value: persistedValue,
  };
}

function midiCcKey(channel: number, cc: number): string {
  return `${normalizeMidiChannel(channel)}:${normalizeMidiCc(cc)}`;
}

function normalizeMidiChannel(value: number): number {
  return clampInteger(value, 1, 16);
}

function normalizeMidiCc(value: number): number {
  return clampInteger(value, 0, 127);
}

function normalizeMidiValue(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  const rounded = Math.round(value);
  return Math.max(min, Math.min(max, rounded));
}

function loadMidiCcValues(): MidiCcValueMap {
  const values = new Map<string, number>();

  try {
    const raw = window.localStorage.getItem(MIDI_CC_STORAGE_KEY);
    if (!raw) return values;

    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return values;

    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const [channelText, ccText] = key.split(':');
      const channel = Number(channelText);
      const cc = Number(ccText);
      if (!Number.isFinite(channel) || !Number.isFinite(cc)) continue;

      values.set(midiCcKey(channel, cc), normalizeMidiValue(value));
    }
  } catch {
    return values;
  }

  return values;
}

function saveMidiCcValues(values: MidiCcValueMap): void {
  try {
    const serialized = Object.fromEntries(values.entries());
    window.localStorage.setItem(MIDI_CC_STORAGE_KEY, JSON.stringify(serialized));
  } catch {
    // Local storage can be unavailable in private or restricted browsing contexts.
  }
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

function sanitizePatchFilename(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');

  return cleaned || 'untitled-patch';
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
    ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
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
  if (value.expression !== undefined && typeof value.expression !== 'string') {
    throw new Error(`Node "${value.id}" expression must be a string.`);
  }
  if (value.subpatchName !== undefined && typeof value.subpatchName !== 'string') {
    throw new Error(`Node "${value.id}" subpatchName must be a string.`);
  }
  if (value.subpatchCloneId !== undefined && typeof value.subpatchCloneId !== 'string') {
    throw new Error(`Node "${value.id}" subpatchCloneId must be a string.`);
  }

  const position = value.position === undefined ? undefined : parsePosition(value.position, value.id);
  const parsedInputs = value.inputs === undefined ? undefined : parsePortDefinitions(value.inputs, `Node "${value.id}" inputs`);
  const outputs = value.outputs === undefined ? undefined : parsePortDefinitions(value.outputs, `Node "${value.id}" outputs`);
  const subpatch = value.subpatch === undefined ? undefined : parsePatchObject(value.subpatch, `Node "${value.id}" subpatch`);
  const expression = value.type === 'Expression'
    ? (value.expression ?? DEFAULT_EXPRESSION)
    : value.expression;
  const inputs = value.type === 'Expression' && expression !== undefined
    ? (parsedInputs ?? expressionInputDefinitions(expression))
    : parsedInputs;
  const params = value.type === 'Expression' && inputs
    ? syncParamsToInputs(value.params, inputs)
    : value.params;

  return {
    id: value.id,
    type: value.type,
    ...(value.subpatchName ? { subpatchName: value.subpatchName } : {}),
    ...(value.subpatchCloneId ? { subpatchCloneId: value.subpatchCloneId } : {}),
    ...(expression !== undefined ? { expression } : {}),
    params,
    ...(position ? { position } : {}),
    ...(inputs ? { inputs } : {}),
    ...(outputs ? { outputs } : {}),
    ...(subpatch ? { subpatch } : {}),
  };
}

function parsePatchObject(value: unknown, label: string): Patch {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  if (!Array.isArray(value.nodes)) {
    throw new Error(`${label} must contain a nodes array.`);
  }
  if (!Array.isArray(value.links)) {
    throw new Error(`${label} must contain a links array.`);
  }

  return {
    nodes: value.nodes.map((node, index) => parsePatchNode(node, index)),
    links: value.links.map((link, index) => parsePatchLink(link, index)),
  };
}

function parsePortDefinitions(value: unknown, label: string): PortDefinition[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }

  return value.map((port, index) => {
    if (!isRecord(port) || typeof port.name !== 'string' || port.name.trim() === '') {
      throw new Error(`${label} port ${index} needs a string name.`);
    }

    const defaultValue = port.defaultValue;
    if (defaultValue !== undefined && (typeof defaultValue !== 'number' || !Number.isFinite(defaultValue))) {
      throw new Error(`${label} port "${port.name}" defaultValue must be numeric.`);
    }

    const connectable = port.connectable;
    if (connectable !== undefined && typeof connectable !== 'boolean') {
      throw new Error(`${label} port "${port.name}" connectable must be boolean.`);
    }

    const min = port.min;
    const max = port.max;
    if (min !== undefined && (typeof min !== 'number' || !Number.isFinite(min))) {
      throw new Error(`${label} port "${port.name}" min must be numeric.`);
    }
    if (max !== undefined && (typeof max !== 'number' || !Number.isFinite(max))) {
      throw new Error(`${label} port "${port.name}" max must be numeric.`);
    }

    const integer = port.integer;
    if (integer !== undefined && typeof integer !== 'boolean') {
      throw new Error(`${label} port "${port.name}" integer must be boolean.`);
    }

    return {
      name: port.name,
      ...(defaultValue === undefined ? {} : { defaultValue }),
      ...(connectable === undefined ? {} : { connectable }),
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
      ...(integer === undefined ? {} : { integer }),
    };
  });
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

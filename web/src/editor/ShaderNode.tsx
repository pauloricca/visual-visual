import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { getNodeDefinition, getNodeTypeLabel, NODE_TYPE_LIST } from '../graph/nodeTypes';
import type { NodeType, PatchNode } from '../graph/types';
import type { ShaderFlowNode, ShaderNodeData } from './flowPatch';

export function ShaderNode({ data, selected, dragging }: NodeProps<ShaderFlowNode>) {
  const node = data.patchNode;
  const updateNodeInternals = useUpdateNodeInternals();
  const draggedPortRef = useRef<{ side: 'input' | 'output'; port: string; pointerId: number } | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const inputPortRowsRef = useRef<Record<string, HTMLDivElement | null>>({});
  const outputPortRowsRef = useRef<Record<string, HTMLDivElement | null>>({});
  const expressionInputRef = useRef<HTMLInputElement | null>(null);
  const skipNextExpressionBlurRef = useRef(false);
  const [dragSource, setDragSource] = useState<{ side: 'input' | 'output'; port: string } | null>(null);
  const [dragTarget, setDragTarget] = useState<{ side: 'input' | 'output'; port: string } | null>(null);
  const [expressionDraft, setExpressionDraft] = useState(node.expression ?? '');
  const definition = node.type ? getNodeDefinition(node as PatchNode) : null;
  const isScope = node.type === 'Scope';
  const isMeter = node.type === 'Meter';
  const isGroup = node.type === 'Group';
  const isExpression = node.type === 'Expression';
  const canRenameInputs = node.type === 'Outs';
  const canRenameOutputs = node.type === 'Ins';
  const outputCount = definition?.outputs.length ?? 0;
  const previewInputPort = data.previewPort?.side === 'input' ? data.previewPort.name : null;
  const previewOutputPort = data.previewPort?.side === 'output' ? data.previewPort.name : null;
  const previewAddsOutput = Boolean(
    previewOutputPort
    && definition
    && !definition.outputs.some((output) => output.name === previewOutputPort),
  );
  const showHeaderOutput = outputCount === 1 && !previewAddsOutput;
  const headerOutputPort = showHeaderOutput && definition ? definition.outputs[0]?.name ?? null : null;
  const selectedLinkInputs = data.selectedLinkPorts?.inputs ?? [];
  const selectedLinkOutputs = data.selectedLinkPorts?.outputs ?? [];
  const inputLabelWidth = definition
    ? `${Math.max(0, ...definition.inputs.map((input) => input.name.length))}ch`
    : '0ch';
  const outputLabelWidth = definition
    ? `${Math.max(0, ...definition.outputs.map((output) => output.name.length))}ch`
    : '0ch';
  const inputStyle = { '--input-label-width': inputLabelWidth } as CSSProperties;
  const className = [
    'shader-node',
    selected ? 'shader-node-selected' : '',
    dragging ? 'shader-node-dragging' : '',
    isScope ? 'shader-node-scope' : '',
    isMeter ? 'shader-node-meter' : '',
    isGroup ? 'shader-node-group' : '',
    isExpression ? 'shader-node-expression' : '',
  ].filter(Boolean).join(' ');

  useLayoutEffect(() => {
    const animationFrame = requestAnimationFrame(() => updateNodeInternals(node.id));
    return () => cancelAnimationFrame(animationFrame);
  }, [inputLabelWidth, node.id, outputCount, outputLabelWidth, previewAddsOutput, updateNodeInternals]);

  useEffect(() => {
    if (document.activeElement === expressionInputRef.current) return;
    setExpressionDraft(node.expression ?? '');
  }, [node.expression]);

  function commitExpressionDraft() {
    if (!isExpression) return;
    data.onExpressionCommit?.(node.id, expressionDraft);
  }

  function moveDraggedPortToTarget(side: 'input' | 'output', draggedPort: string, targetPort: string, portOrder: string[]) {
    if (draggedPort === targetPort) return;

    const fromIndex = portOrder.indexOf(draggedPort);
    const toIndex = portOrder.indexOf(targetPort);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;

    const direction: -1 | 1 = fromIndex < toIndex ? 1 : -1;
    const steps = Math.abs(toIndex - fromIndex);
    for (let step = 0; step < steps; step += 1) {
      data.onPortMove(node.id, side, draggedPort, direction);
    }
  }

  useEffect(() => {
    function handlePointerMove(event: globalThis.PointerEvent) {
      const draggedPort = draggedPortRef.current;
      if (!draggedPort || draggedPort.pointerId !== event.pointerId || !definition) return;

      const dragStart = dragStartRef.current;
      if (!dragStart) return;

      const moved = Math.hypot(event.clientX - dragStart.x, event.clientY - dragStart.y) > 3;
      if (!moved) return;

      event.preventDefault();
      const side = draggedPort.side;
      const portOrder = side === 'input'
        ? definition.inputs.map((port) => port.name)
        : definition.outputs.map((port) => port.name);
      const rows = side === 'input' ? inputPortRowsRef.current : outputPortRowsRef.current;

      const targets = portOrder.flatMap((port) => {
        const row = rows[port];
        if (!row) return [];
        const rect = row.getBoundingClientRect();
        return [{
          port,
          centerY: rect.top + rect.height / 2,
        }];
      });

      if (targets.length === 0) return;

      const targetPort = targets.reduce((best, current) => {
        const bestDistance = Math.abs(event.clientY - best.centerY);
        const currentDistance = Math.abs(event.clientY - current.centerY);
        return currentDistance < bestDistance ? current : best;
      }).port;

      setDragSource((current) => current ?? { side, port: draggedPort.port });
      setDragTarget({ side, port: targetPort });
      moveDraggedPortToTarget(side, draggedPort.port, targetPort, portOrder);
    }

    function stopDragging(pointerId: number) {
      if (!draggedPortRef.current || draggedPortRef.current.pointerId !== pointerId) return;

      draggedPortRef.current = null;
      dragStartRef.current = null;
      setDragSource(null);
      setDragTarget(null);
    }

    function handlePointerUp(event: globalThis.PointerEvent) {
      stopDragging(event.pointerId);
    }

    function handlePointerCancel(event: globalThis.PointerEvent) {
      stopDragging(event.pointerId);
    }

    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
    };
  }, [definition, node.id]);

  function handlePortPointerDown(
    event: PointerEvent<HTMLSpanElement>,
    side: 'input' | 'output',
    port: string,
  ) {
    if (event.button !== 0) return;

    event.preventDefault();
    event.stopPropagation();
    data.onPortSelect?.(node.id, side, port);
    draggedPortRef.current = { side, port, pointerId: event.pointerId };
    dragStartRef.current = { x: event.clientX, y: event.clientY };
    setDragSource(null);
    setDragTarget(null);
  }

  return (
    <div className={className}>
      <div className="shader-node-title">
        <NodeTypePicker
          nodeType={node.type}
          displayLabel={node.type === 'Group' ? (node.subpatchName ?? node.id) : undefined}
          isEditingSubpatch={data.isEditingSubpatch === true}
          open={data.isTypePickerOpen}
          onOpen={() => data.onTypeEditStart(node.id)}
          onClose={data.onTypeEditEnd}
          onChange={(type) => data.onTypeChange(node.id, type)}
          onCustomLabelCommit={node.type === 'Group'
            ? (nextName) => data.onSubpatchNameChange?.(node.id, nextName)
            : undefined}
        />
        {headerOutputPort ? (
          <Handle
            id={`out:${headerOutputPort}`}
            type="source"
            position={Position.Right}
            className={[
              'shader-handle shader-handle-output shader-handle-output-title',
              selectedLinkOutputs.includes(headerOutputPort) ? 'shader-handle-selected-link' : '',
            ].filter(Boolean).join(' ')}
            onDoubleClick={(event) => {
              event.stopPropagation();
              data.onPortDoubleClick(node.id, 'output', headerOutputPort);
            }}
          />
        ) : null}
      </div>
      {definition && isScope ? (
        <div className="shader-node-body shader-node-body-scope">
          <Handle
            id="in:value"
            type="target"
            position={Position.Left}
            className={[
              'shader-handle shader-handle-input shader-handle-scope',
              selectedLinkInputs.includes('value') ? 'shader-handle-selected-link' : '',
            ].filter(Boolean).join(' ')}
            onDoubleClick={(event) => {
              event.stopPropagation();
              data.onPortDoubleClick(node.id, 'input', 'value');
            }}
          />
          <div className="scope-preview" data-scope-node-id={node.id} />
        </div>
      ) : definition && isMeter ? (
        <div className="shader-node-body shader-node-body-meter">
          <Handle
            id="in:value"
            type="target"
            position={Position.Left}
            className={[
              'shader-handle shader-handle-input shader-handle-meter',
              selectedLinkInputs.includes('value') ? 'shader-handle-selected-link' : '',
            ].filter(Boolean).join(' ')}
            onDoubleClick={(event) => {
              event.stopPropagation();
              data.onPortDoubleClick(node.id, 'input', 'value');
            }}
          />
          <div className="meter-label" data-meter-node-id={node.id}>
            <div className="meter-label-row">min <span data-meter-min>--</span></div>
            <div className="meter-label-row">max <span data-meter-max>--</span></div>
          </div>
        </div>
      ) : definition ? (
        (() => {
          const inputPorts = [
            ...definition.inputs.map((input) => ({ ...input, preview: false })),
            ...(previewInputPort && !definition.inputs.some((input) => input.name === previewInputPort)
              ? [{ name: previewInputPort, preview: true }]
              : []),
          ];
          const outputPorts = [
            ...definition.outputs.map((output) => ({ ...output, preview: false })),
            ...(previewOutputPort && !definition.outputs.some((output) => output.name === previewOutputPort)
              ? [{ name: previewOutputPort, preview: true }]
              : []),
          ];

          return (
        <div className={[
          'shader-node-body',
          isExpression ? 'shader-node-body-expression' : '',
          outputPorts.length === 0 || showHeaderOutput ? 'shader-node-body-no-outputs' : '',
        ].filter(Boolean).join(' ')}>
          {isExpression ? (
            <input
              ref={expressionInputRef}
              aria-label="GLSL expression"
              className="expression-editor nodrag nopan nowheel"
              spellCheck={false}
              type="text"
              value={expressionDraft}
              onChange={(event) => setExpressionDraft(event.currentTarget.value)}
              onBlur={() => {
                if (skipNextExpressionBlurRef.current) {
                  skipNextExpressionBlurRef.current = false;
                  return;
                }
                commitExpressionDraft();
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitExpressionDraft();
                  skipNextExpressionBlurRef.current = true;
                  event.currentTarget.blur();
                }
              }}
              onPointerDown={(event) => event.stopPropagation()}
            />
          ) : null}
          <div className="shader-ports shader-inputs" style={inputStyle}>
            {inputPorts.map((input) => (
            <div
              className={[
                'shader-port shader-port-input',
                input.preview ? 'shader-port-preview' : '',
              ].filter(Boolean).join(' ')}
              key={`${input.preview ? 'preview' : 'port'}:${input.name}`}
              ref={(element) => {
                inputPortRowsRef.current[input.name] = element;
              }}
              onDoubleClick={(event) => {
                if (input.preview) return;
                if (input.connectable === false) return;
                event.stopPropagation();
                data.onPortDoubleClick(node.id, 'input', input.name);
              }}
            >
              {input.connectable !== false ? (
                <Handle
                  id={`in:${input.name}`}
                  type="target"
                  position={Position.Left}
                  className={[
                    'shader-handle shader-handle-input',
                    selectedLinkInputs.includes(input.name) ? 'shader-handle-selected-link' : '',
                  ].filter(Boolean).join(' ')}
                  onDoubleClick={(event) => {
                    if (input.preview) return;
                    event.stopPropagation();
                    data.onPortDoubleClick(node.id, 'input', input.name);
                  }}
                />
              ) : null}
              <PortNameLabel
                name={input.name}
                editable={canRenameInputs && !input.preview}
                draggable={false}
                preview={input.preview}
                selected={data.selectedPort?.side === 'input' && data.selectedPort.name === input.name}
                activeDragTarget={dragTarget?.side === 'input' && dragTarget.port === input.name}
                activeDragSource={dragSource?.side === 'input' && dragSource.port === input.name}
                onPointerDown={(event) => {
                  if (input.preview) return;
                  if (!canRenameInputs) return;
                  handlePortPointerDown(event, 'input', input.name);
                }}
                onChange={(nextName) => data.onPortNameChange(node.id, 'input', input.name, nextName)}
              />
              {!input.preview ? (
                <NumericScrubber
                  value={node.params[input.name] ?? input.defaultValue ?? 0}
                  min={input.min}
                  max={input.max}
                  integer={input.integer}
                  onChange={(value) => data.onParamChange(node.id, input.name, value)}
                />
              ) : null}
            </div>
            ))}
          </div>
          {outputPorts.length > 0 && !showHeaderOutput ? (
            <div className="shader-ports shader-outputs">
              {outputPorts.map((output) => (
              <div
                className={[
                  'shader-port shader-port-output',
                  output.preview ? 'shader-port-preview' : '',
                ].filter(Boolean).join(' ')}
                key={`${output.preview ? 'preview' : 'port'}:${output.name}`}
                ref={(element) => {
                  outputPortRowsRef.current[output.name] = element;
                }}
                onDoubleClick={(event) => {
                  if (output.preview) return;
                  event.stopPropagation();
                  data.onPortDoubleClick(node.id, 'output', output.name);
                }}
              >
                <PortNameLabel
                  name={output.name}
                  editable={canRenameOutputs && !output.preview}
                  draggable={false}
                  preview={output.preview}
                  selected={data.selectedPort?.side === 'output' && data.selectedPort.name === output.name}
                  activeDragTarget={dragTarget?.side === 'output' && dragTarget.port === output.name}
                  activeDragSource={dragSource?.side === 'output' && dragSource.port === output.name}
                  onPointerDown={(event) => {
                    if (output.preview) return;
                    if (!canRenameOutputs) return;
                    handlePortPointerDown(event, 'output', output.name);
                  }}
                  onChange={(nextName) => data.onPortNameChange(node.id, 'output', output.name, nextName)}
                />
                <Handle
                  id={`out:${output.name}`}
                  type="source"
                  position={Position.Right}
                  className={[
                    'shader-handle shader-handle-output',
                    selectedLinkOutputs.includes(output.name) ? 'shader-handle-selected-link' : '',
                  ].filter(Boolean).join(' ')}
                  onDoubleClick={(event) => {
                    if (output.preview) return;
                    event.stopPropagation();
                    data.onPortDoubleClick(node.id, 'output', output.name);
                  }}
                />
              </div>
              ))}
            </div>
          ) : null}
        </div>
          );
        })()
      ) : (
        <div className="shader-node-body shader-node-body-draft">
          <div className="shader-ports shader-inputs">
            <div className="shader-port shader-port-input">
              <Handle
                id="in:value"
                type="target"
                position={Position.Left}
                className="shader-handle shader-handle-input"
              />
              <span>in</span>
            </div>
          </div>
          <div className="shader-ports shader-outputs">
            <div className="shader-port shader-port-output">
              <span>out</span>
              <Handle
                id="out:value"
                type="source"
                position={Position.Right}
                className="shader-handle shader-handle-output"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface NodeTypePickerProps {
  nodeType: NodeType | null;
  displayLabel?: string;
  isEditingSubpatch: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onChange: (type: NodeType) => void;
  onCustomLabelCommit?: (label: string) => void;
}

interface PortNameLabelProps {
  name: string;
  editable: boolean;
  draggable?: boolean;
  selected?: boolean;
  preview?: boolean;
  activeDragTarget?: boolean;
  activeDragSource?: boolean;
  onPointerDown?: (event: PointerEvent<HTMLSpanElement>) => void;
  onChange: (nextName: string) => void;
}

function PortNameLabel({
  name,
  editable,
  draggable = false,
  selected = false,
  preview = false,
  activeDragTarget = false,
  activeDragSource = false,
  onPointerDown,
  onChange,
}: PortNameLabelProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editing) {
      setDraft(name);
    }
  }, [editing, name]);

  useEffect(() => {
    if (!editing) return;

    const animationFrame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [editing]);

  function commitDraft() {
    onChange(draft);
    setEditing(false);
  }

  function cancelDraft() {
    setDraft(name);
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="port-name-editor nodrag nopan"
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commitDraft}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') {
            commitDraft();
          }
          if (event.key === 'Escape') {
            cancelDraft();
          }
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        spellCheck={false}
      />
    );
  }

  return (
    <span
      className={[
        'port-name-label',
        editable ? 'port-name-label-editable' : '',
        draggable ? 'port-name-label-draggable nodrag nopan' : '',
          selected ? 'port-name-label-selected' : '',
          preview ? 'port-name-label-preview' : '',
        activeDragTarget ? 'port-name-label-drag-target' : '',
        activeDragSource ? 'port-name-label-drag-source' : '',
      ].filter(Boolean).join(' ')}
      draggable={draggable}
        title={preview
          ? 'Drop a connection here to create this port'
          : editable
            ? 'Drag to reorder. Double-click to rename'
            : undefined}
        onPointerDown={(event) => {
          onPointerDown?.(event);
        }}
      onDoubleClick={(event) => {
        if (!editable) return;
        event.preventDefault();
        event.stopPropagation();
        setEditing(true);
      }}
    >
      {name}
    </span>
  );
}

function NodeTypePicker({
  nodeType,
  displayLabel,
  isEditingSubpatch,
  open,
  onOpen,
  onClose,
  onChange,
  onCustomLabelCommit,
}: NodeTypePickerProps) {
  const nodeTypeLabel = nodeType ? getNodeTypeLabel(nodeType) : 'type';
  const pickerLabel = displayLabel ?? nodeTypeLabel;
  const [query, setQuery] = useState<string>(nodeType ? pickerLabel : '');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [dragIntent, setDragIntent] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const searchQuery = displayLabel && query.trim() === pickerLabel
    ? nodeTypeLabel
    : query;
  const options = useMemo(() => NODE_TYPE_LIST.filter((type) => {
    if (type === 'Group') return false;
    if ((type === 'Ins' || type === 'Outs') && !isEditingSubpatch) return false;

    const normalizedQuery = searchQuery.trim().toLowerCase();
    return (
      type.toLowerCase().includes(normalizedQuery) ||
      getNodeTypeLabel(type).toLowerCase().includes(normalizedQuery)
    );
  }), [isEditingSubpatch, searchQuery]);
  useEffect(() => {
    if (!open) {
      setQuery(nodeType ? pickerLabel : '');
      setHighlightedIndex(0);
    }
  }, [nodeType, open, pickerLabel]);

  useEffect(() => {
    if (open) {
      setQuery(nodeType ? pickerLabel : '');
      setHighlightedIndex(0);
      const focusAndSelect = () => {
        inputRef.current?.focus({ preventScroll: true });
        inputRef.current?.select();
      };
      const animationFrame = requestAnimationFrame(focusAndSelect);
      const firstTimeout = window.setTimeout(focusAndSelect, 0);
      const secondTimeout = window.setTimeout(focusAndSelect, 50);

      return () => {
        cancelAnimationFrame(animationFrame);
        window.clearTimeout(firstTimeout);
        window.clearTimeout(secondTimeout);
      };
    }
  }, [nodeType, open, pickerLabel]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[highlightedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex, open]);

  function choose(type: NodeType) {
    onChange(type);
    onClose();
  }

  function commitCustomLabel(): boolean {
    const label = query.trim();
    if (!onCustomLabelCommit || label.length === 0) return false;

    onCustomLabelCommit(label);
    onClose();
    return true;
  }

  function closeOrCommitCustomLabel() {
    if (options.length === 0 && commitCustomLabel()) return;
    onClose();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    event.stopPropagation();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlightedIndex((index) => Math.min(index + 1, Math.max(options.length - 1, 0)));
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightedIndex((index) => Math.max(index - 1, 0));
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const selectedType = options[highlightedIndex] ?? options[0];
      if (selectedType) {
        choose(selectedType);
      } else {
        commitCustomLabel();
      }
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }

  if (!open) {
    return (
      <button
        className={dragIntent ? 'node-type-picker-button node-type-picker-button-drag-intent' : 'node-type-picker-button'}
        type="button"
        onPointerDown={(event) => {
          pointerStartRef.current = { x: event.clientX, y: event.clientY };
          setDragIntent(false);
        }}
        onPointerMove={(event) => {
          const pointerStart = pointerStartRef.current;
          if (!pointerStart) return;

          const moved = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 4;
          if (!moved) return;

          setDragIntent(true);
          event.currentTarget.blur();
        }}
        onPointerUp={() => {
          window.setTimeout(() => setDragIntent(false), 0);
        }}
        onPointerCancel={() => {
          pointerStartRef.current = null;
          setDragIntent(false);
        }}
        onClick={(event) => {
          const pointerStart = pointerStartRef.current;
          pointerStartRef.current = null;
          const moved = pointerStart
            ? Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 4
            : false;
          if (moved) {
            event.currentTarget.blur();
            return;
          }

          event.stopPropagation();
          onOpen();
        }}
      >
        {pickerLabel}
      </button>
    );
  }

  return (
    <span className="node-type-picker-open-shell">
      <span className="node-type-picker-placeholder" aria-hidden="true">{pickerLabel}</span>
      <div className="node-type-picker nodrag nopan nowheel" onMouseDown={(event) => event.stopPropagation()}>
        <input
          ref={inputRef}
          className="node-type-picker-input"
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setHighlightedIndex(0);
            if (menuRef.current) {
              menuRef.current.scrollTop = 0;
            }
          }}
          onBlur={closeOrCommitCustomLabel}
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={handleKeyDown}
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          spellCheck={false}
        />
        <div
          ref={menuRef}
          className="node-type-picker-menu nowheel"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onWheel={(event) => event.stopPropagation()}
        >
          {options.map((type, index) => (
            <button
              className={index === highlightedIndex ? 'active' : ''}
              key={type}
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                choose(type);
              }}
            >
              {getNodeTypeLabel(type)}
            </button>
          ))}
          {options.length === 0 ? <div className="node-type-picker-empty">no match</div> : null}
        </div>
      </div>
    </span>
  );
}

interface NumericScrubberProps {
  value: number;
  min?: number;
  max?: number;
  integer?: boolean;
  onChange: (value: number) => void;
}

function NumericScrubber({ value, min, max, integer = false, onChange }: NumericScrubberProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(formatDisplayValue(value));
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    anchorY: number;
    anchorValue: number;
    currentValue: number;
    step: number;
    dragging: boolean;
  } | null>(null);

  useEffect(() => {
    if (!editing) {
      setDraft(formatDisplayValue(value));
    }
  }, [editing, value]);

  useEffect(() => {
    if (editing) {
      setDraft(formatDisplayValue(value));
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, value]);

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    event.stopPropagation();
    dragRef.current = {
      pointerId: event.pointerId,
      anchorY: event.clientY,
      anchorValue: value,
      currentValue: value,
      step: scrubberStep(event),
      dragging: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function updateDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const distance = drag.anchorY - event.clientY;
    if (!drag.dragging && Math.abs(distance) < 3) return;

    drag.dragging = true;
    event.preventDefault();
    event.stopPropagation();

    const step = scrubberStep(event);
    if (step !== drag.step) {
      drag.anchorY = event.clientY;
      drag.anchorValue = drag.currentValue;
      drag.step = step;
    }

    const nextValue = constrainValue(
      roundValue(drag.anchorValue + (drag.anchorY - event.clientY) * drag.step),
      min,
      max,
      integer,
    );
    drag.currentValue = nextValue;
    onChange(nextValue);
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    event.stopPropagation();
    event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;

    if (!drag.dragging) {
      setEditing(true);
    }
  }

  function commitDraft() {
    const nextValue = Number(draft.trim());
    if (Number.isFinite(nextValue)) {
      onChange(constrainValue(nextValue, min, max, integer));
    } else {
      setDraft(formatDisplayValue(value));
    }
    setEditing(false);
  }

  function cancelDraft() {
    setDraft(formatDisplayValue(value));
    setEditing(false);
  }

  function handleEditKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    event.stopPropagation();
    if (event.key === 'Enter') {
      commitDraft();
    }
    if (event.key === 'Escape') {
      cancelDraft();
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="numeric-scrubber numeric-scrubber-editing nodrag nopan"
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={integer ? 1 : undefined}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commitDraft}
        onKeyDown={handleEditKeyDown}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        spellCheck={false}
      />
    );
  }

  return (
    <div
      className="numeric-scrubber nodrag nopan"
      role="spinbutton"
      tabIndex={0}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      onPointerDown={startDrag}
      onPointerMove={updateDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onMouseDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          setEditing(true);
        }
      }}
    >
      {formatDisplayValue(value)}
    </div>
  );
}

function roundValue(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function scrubberStep(event: { metaKey: boolean; shiftKey: boolean }): number {
  return event.metaKey ? 0.1 : event.shiftKey ? 0.001 : 0.01;
}

function constrainValue(value: number, min?: number, max?: number, integer = false): number {
  const rounded = integer ? Math.round(value) : value;
  return Math.min(Math.max(rounded, min ?? -Infinity), max ?? Infinity);
}

function formatDisplayValue(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = roundValue(value);
  return Number.isInteger(rounded) ? rounded.toString() : rounded.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

export function makeNodeId(type: PatchNode['type'] | 'node', existingIds: Set<string>): string {
  const base = type.toLowerCase();
  let index = 1;
  let id = `${base}_${index}`;
  while (existingIds.has(id)) {
    index += 1;
    id = `${base}_${index}`;
  }
  return id;
}

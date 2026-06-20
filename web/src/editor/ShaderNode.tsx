import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { getDefinition, NODE_TYPE_LIST } from '../graph/nodeTypes';
import type { NodeType, PatchNode } from '../graph/types';
import type { ShaderFlowNode, ShaderNodeData } from './flowPatch';

export function ShaderNode({ data, selected, dragging }: NodeProps<ShaderFlowNode>) {
  const node = data.patchNode;
  const updateNodeInternals = useUpdateNodeInternals();
  const definition = node.type ? getDefinition(node.type) : null;
  const isScope = node.type === 'Scope';
  const isMeter = node.type === 'Meter';
  const outputCount = definition?.outputs.length ?? 0;
  const singleOutput = outputCount === 1 ? definition?.outputs[0] : null;
  const hasBodyOutputs = outputCount > 1;
  const inputLabelWidth = definition
    ? `${Math.max(0, ...definition.inputs.map((input) => input.name.length))}ch`
    : '0ch';
  const inputStyle = { '--input-label-width': inputLabelWidth } as CSSProperties;
  const className = [
    'shader-node',
    selected ? 'shader-node-selected' : '',
    dragging ? 'shader-node-dragging' : '',
    isScope ? 'shader-node-scope' : '',
    isMeter ? 'shader-node-meter' : '',
  ].filter(Boolean).join(' ');

  useLayoutEffect(() => {
    const animationFrame = requestAnimationFrame(() => updateNodeInternals(node.id));
    return () => cancelAnimationFrame(animationFrame);
  }, [hasBodyOutputs, inputLabelWidth, node.id, outputCount, updateNodeInternals]);

  return (
    <div className={className}>
      <div className="shader-node-title">
        <NodeTypePicker
          nodeType={node.type}
          open={data.isTypePickerOpen}
          onOpen={() => data.onTypeEditStart(node.id)}
          onClose={data.onTypeEditEnd}
          onChange={(type) => data.onTypeChange(node.id, type)}
        />
        {singleOutput ? (
          <Handle
            id={`out:${singleOutput.name}`}
            type="source"
            position={Position.Right}
            className="shader-handle shader-handle-output shader-handle-output-title"
            onDoubleClick={(event) => {
              event.stopPropagation();
              data.onPortDoubleClick(node.id, 'output', singleOutput.name);
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
            className="shader-handle shader-handle-input shader-handle-scope"
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
            className="shader-handle shader-handle-input shader-handle-meter"
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
        <div className={[
          'shader-node-body',
          !hasBodyOutputs ? 'shader-node-body-no-outputs' : '',
        ].filter(Boolean).join(' ')}>
          <div className="shader-ports shader-inputs" style={inputStyle}>
            {definition.inputs.map((input) => (
            <div
              className="shader-port shader-port-input"
              key={input.name}
              onDoubleClick={(event) => {
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
                  className="shader-handle shader-handle-input"
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    data.onPortDoubleClick(node.id, 'input', input.name);
                  }}
                />
              ) : null}
              <span>{input.name}</span>
              <NumericScrubber
                value={node.params[input.name] ?? input.defaultValue ?? 0}
                min={input.min}
                max={input.max}
                integer={input.integer}
                onChange={(value) => data.onParamChange(node.id, input.name, value)}
              />
            </div>
            ))}
          </div>
          {hasBodyOutputs ? (
            <div className="shader-ports shader-outputs">
              {definition.outputs.map((output) => (
              <div
                className="shader-port shader-port-output"
                key={output.name}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  data.onPortDoubleClick(node.id, 'output', output.name);
                }}
              >
                <span>{output.name}</span>
                <Handle
                  id={`out:${output.name}`}
                  type="source"
                  position={Position.Right}
                  className="shader-handle shader-handle-output"
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    data.onPortDoubleClick(node.id, 'output', output.name);
                  }}
                />
              </div>
              ))}
            </div>
          ) : null}
        </div>
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
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onChange: (type: NodeType) => void;
}

function NodeTypePicker({ nodeType, open, onOpen, onClose, onChange }: NodeTypePickerProps) {
  const [query, setQuery] = useState<string>(nodeType ?? '');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [dragIntent, setDragIntent] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const options = NODE_TYPE_LIST.filter((type) =>
    type.toLowerCase().includes(query.trim().toLowerCase()),
  );

  useEffect(() => {
    if (!open) {
      setQuery(nodeType ?? '');
      setHighlightedIndex(0);
    }
  }, [nodeType, open]);

  useEffect(() => {
    if (open) {
      setQuery(nodeType ?? '');
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
  }, [nodeType, open]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[highlightedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex, open, options]);

  function choose(type: NodeType) {
    onChange(type);
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
        {nodeType ?? 'type'}
      </button>
    );
  }

  return (
    <span className="node-type-picker-open-shell">
      <span className="node-type-picker-placeholder" aria-hidden="true">{nodeType ?? 'type'}</span>
      <div className="node-type-picker nodrag nopan nowheel" onMouseDown={(event) => event.stopPropagation()}>
        <input
          ref={inputRef}
          className="node-type-picker-input"
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setHighlightedIndex(0);
          }}
          onBlur={onClose}
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={handleKeyDown}
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          spellCheck={false}
        />
        <div
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
              {type}
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

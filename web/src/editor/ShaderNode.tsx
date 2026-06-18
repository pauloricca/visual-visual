import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { getDefinition, NODE_TYPE_LIST } from '../graph/nodeTypes';
import type { NodeType, PatchNode } from '../graph/types';
import type { ShaderFlowNode, ShaderNodeData } from './flowPatch';

export function ShaderNode({ data, selected }: NodeProps<ShaderFlowNode>) {
  const node = data.patchNode;
  const definition = node.type ? getDefinition(node.type) : null;

  return (
    <div className={selected ? 'shader-node shader-node-selected' : 'shader-node'}>
      <div className="shader-node-title">
        <NodeTypePicker
          nodeType={node.type}
          open={data.isTypePickerOpen}
          onOpen={() => data.onTypeEditStart(node.id)}
          onClose={data.onTypeEditEnd}
          onChange={(type) => data.onTypeChange(node.id, type)}
        />
        <NodeIdEditor
          value={node.id}
          onChange={(nextId) => data.onIdChange(node.id, nextId)}
        />
      </div>
      {definition ? (
        <div className="shader-node-body">
          <div className="shader-ports shader-inputs">
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
                onChange={(value) => data.onParamChange(node.id, input.name, value)}
              />
            </div>
            ))}
          </div>
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

interface NodeIdEditorProps {
  value: string;
  onChange: (nextId: string) => void;
}

function NodeIdEditor({ value, onChange }: NodeIdEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editing) {
      setDraft(value);
    }
  }, [editing, value]);

  useEffect(() => {
    if (!editing) return;

    setDraft(value);
    const animationFrame = requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.select();
    });

    return () => cancelAnimationFrame(animationFrame);
  }, [editing, value]);

  function commit() {
    onChange(draft);
    setEditing(false);
  }

  function cancel() {
    setDraft(value);
    setEditing(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="shader-node-id-input nodrag nopan"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        spellCheck={false}
      />
    );
  }

  return (
    <button
      className="shader-node-id nodrag nopan"
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        setEditing(true);
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      title={value}
    >
      {value}
    </button>
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
  const inputRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
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
        className="node-type-picker-button nodrag nopan"
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        {nodeType ?? 'type'}
      </button>
    );
  }

  return (
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
  );
}

interface NumericScrubberProps {
  value: number;
  onChange: (value: number) => void;
}

function NumericScrubber({ value, onChange }: NumericScrubberProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(formatDisplayValue(value));
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startValue: number;
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
      startY: event.clientY,
      startValue: value,
      dragging: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function updateDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const distance = drag.startY - event.clientY;
    if (!drag.dragging && Math.abs(distance) < 3) return;

    drag.dragging = true;
    event.preventDefault();
    event.stopPropagation();

    const step = event.metaKey ? 0.1 : event.shiftKey ? 0.001 : 0.01;
    onChange(roundValue(drag.startValue + distance * step));
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
      onChange(nextValue);
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
        type="text"
        inputMode="decimal"
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

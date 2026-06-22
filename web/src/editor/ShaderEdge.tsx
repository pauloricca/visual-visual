import {
  BaseEdge,
  getBezierPath,
  type EdgeProps,
  useReactFlow,
  useViewport,
} from '@xyflow/react';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { LinkMode } from '../graph/types';
import { useEdgeOverlayTarget } from './EdgeOverlayContext';
import type { ShaderFlowEdge } from './flowPatch';

const LINK_CONTROLS_SHOW_DELAY_MS = 260;

export function ShaderEdge(props: EdgeProps<ShaderFlowEdge>) {
  const [linkControlsVisible, setLinkControlsVisible] = useState(false);
  const [edgePath, labelX, labelY] = getBezierPath(props);
  const overlayTarget = useEdgeOverlayTarget();
  const reactFlow = useReactFlow();
  const viewport = useViewport();
  const screenPosition = reactFlow.flowToScreenPosition({ x: labelX, y: labelY });
  const weight = props.data?.weight ?? 1;
  const selected = props.selected ?? false;
  const showLinkControls = selected && props.data?.showLinkControls === true;
  const underlayClassName = [
    'shader-edge-path',
    'shader-edge-path-underlay',
  ].join(' ');
  const edgeClassName = [
    'shader-edge-path',
    'shader-edge-path-foreground',
    selected ? 'shader-edge-path-selected' : '',
  ].filter(Boolean).join(' ');
  const selectedUnderlayStyle = selected ? { stroke: '#0b0b0b', strokeWidth: 6 } : undefined;
  const selectedForegroundStyle = selected ? { stroke: '#b8b8b8', strokeWidth: 2 } : undefined;

  useEffect(() => {
    if (!showLinkControls) {
      setLinkControlsVisible(false);
      return;
    }

    const timeoutId = window.setTimeout(() => setLinkControlsVisible(true), LINK_CONTROLS_SHOW_DELAY_MS);
    return () => window.clearTimeout(timeoutId);
  }, [showLinkControls]);

  return (
    <>
      <BaseEdge
        id={`${props.id}-underlay`}
        path={edgePath}
        className={underlayClassName}
        style={selectedUnderlayStyle}
        interactionWidth={0}
        aria-hidden="true"
      />
      <BaseEdge
        id={props.id}
        path={edgePath}
        className={edgeClassName}
        style={selectedForegroundStyle}
        interactionWidth={18}
      />
      {showLinkControls && linkControlsVisible && overlayTarget ? (
        createPortal(
          <div
            className="edge-weight-label nodrag nopan"
            style={{
              left: screenPosition.x,
              top: screenPosition.y,
              transform: `translate(-50%, -50%) scale(${viewport.zoom})`,
            }}
          >
            <EdgeLinkControls
              value={weight}
              mode={props.data?.mode ?? 'set'}
              onChange={(nextWeight) => props.data?.onWeightChange(props.id, nextWeight)}
              onModeChange={(nextMode) => props.data?.onModeChange(props.id, nextMode)}
            />
          </div>,
          overlayTarget,
        )
      ) : null}
    </>
  );
}

interface EdgeLinkControlsProps {
  value: number;
  mode: LinkMode;
  onChange: (value: number) => void;
  onModeChange: (mode: LinkMode) => void;
}

function EdgeLinkControls({ value, mode, onChange, onModeChange }: EdgeLinkControlsProps) {
  return (
    <>
      <EdgeWeightScrubber value={value} onChange={onChange} />
      <select
        className="edge-link-mode nodrag nopan"
        value={mode}
        onChange={(event) => onModeChange(event.target.value as LinkMode)}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        aria-label="Link mode"
        title="Link mode"
      >
        <option value="set">set</option>
        <option value="add">add</option>
        <option value="multiply">multiply</option>
      </select>
    </>
  );
}

interface EdgeWeightScrubberProps {
  value: number;
  onChange: (value: number) => void;
}

export function EdgeWeightScrubber({ value, onChange }: EdgeWeightScrubberProps) {
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
    if (!editing) return;

    setDraft(formatDisplayValue(value));
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
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

    const nextValue = roundValue(drag.anchorValue + (drag.anchorY - event.clientY) * drag.step);
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
        className="edge-weight-scrubber edge-weight-scrubber-editing nodrag nopan"
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
      className="edge-weight-scrubber nodrag nopan"
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

function scrubberStep(event: { metaKey: boolean; shiftKey: boolean }): number {
  return event.metaKey ? 0.1 : event.shiftKey ? 0.001 : 0.01;
}

function formatDisplayValue(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = roundValue(value);
  return Number.isInteger(rounded) ? rounded.toString() : rounded.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

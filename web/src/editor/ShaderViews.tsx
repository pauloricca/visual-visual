import { useContext, useEffect, useState } from "react";
import {
  SpagbolNodeFrame,
  defineNodeView,
  type SpagbolNodeViewProps,
} from "@pauloricca/spagbol";
import { MidiValuesContext } from "./useMidi";
import { NODE_TYPE_LIST } from "../graph/nodeTypes";

function Expression({ node, patchData, readOnly }: SpagbolNodeViewProps) {
  const expression = String(node.data.expression ?? "a");
  const [draft, setDraft] = useState(expression);
  useEffect(() => setDraft(expression), [expression]);
  return (
    <input
      className="expression-input nodrag nopan nowheel"
      aria-label="GLSL expression"
      value={draft}
      disabled={readOnly}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => patchData({ expression: draft }, true)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(expression);
          event.currentTarget.blur();
        }
      }}
    />
  );
}
function Scope(props: SpagbolNodeViewProps) {
  const id = [...props.path, props.node.id].join("__");
  return (
    <SpagbolNodeFrame {...props} className="visual-scope">
      <canvas
        className="scope-preview"
        data-scope-node-id={id}
        width={220}
        height={128}
      />
    </SpagbolNodeFrame>
  );
}
function Meter(props: SpagbolNodeViewProps) {
  const id = [...props.path, props.node.id].join("__");
  return (
    <SpagbolNodeFrame {...props}>
      <div className="meter-label" data-meter-node-id={id}>
        <div>
          min <span data-meter-min>--</span>
        </div>
        <div>
          max <span data-meter-max>--</span>
        </div>
      </div>
    </SpagbolNodeFrame>
  );
}
function Midi(props: SpagbolNodeViewProps) {
  const values = useContext(MidiValuesContext);
  const value =
    values[
      `${Math.round(props.node.values.channel ?? 1)}:${Math.round(props.node.values.cc ?? 1)}`
    ] ??
    props.node.values.value ??
    0;
  return (
    <SpagbolNodeFrame
      {...props}
      portVisible={(port) => port.direction === "output" || port.id !== "value"}
    >
      <output className="midi-value" aria-label="Live MIDI value">
        {value.toFixed(4)}
      </output>
    </SpagbolNodeFrame>
  );
}
// Only domain content lives here. Spagbol owns frames, ports, type pickers and numeric gestures.
export const shaderViews = Object.fromEntries(
  NODE_TYPE_LIST.map((type) => [
    type,
    defineNodeView({
      autoWidth: true,
      minWidth: 80,
      ...(type === "Expression" ? { body: Expression } : {}),
      ...(type === "Scope" ? { render: Scope } : {}),
      ...(type === "Meter" ? { render: Meter } : {}),
      ...(type === "midiCC" ? { render: Midi } : {}),
    }),
  ]),
);

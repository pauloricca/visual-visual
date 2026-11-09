import { createContext, useEffect, useState } from "react";
import type { Patch } from "../graph/types";
const KEY = "visual-visual.midi-cc-values.v1";
export const MidiValuesContext = createContext<
  Readonly<Record<string, number>>
>({});
export function useMidi() {
  const [values, setValues] = useState<Record<string, number>>(() => {
    try {
      return Object.fromEntries(
        Object.entries(JSON.parse(localStorage.getItem(KEY) ?? "{}"))
          .filter(
            ([, value]) => typeof value === "number" && Number.isFinite(value),
          )
          .map(([key, value]) => [
            key,
            Math.max(0, Math.min(1, value as number)),
          ]),
      );
    } catch {
      return {};
    }
  });
  useEffect(() => {
    if (!navigator.requestMIDIAccess) return;
    let disposed = false;
    let access: MIDIAccess | undefined;
    const attached = new Set<MIDIInput>();
    function message(event: MIDIMessageEvent) {
      const [status = 0, cc = 0, value = 0] = event.data ?? [];
      if ((status & 0xf0) !== 0xb0) return;
      setValues((current) => ({
        ...current,
        [`${(status & 0x0f) + 1}:${cc}`]: value / 127,
      }));
    }
    function attach() {
      for (const input of attached)
        input.removeEventListener("midimessage", message);
      attached.clear();
      for (const input of access?.inputs.values() ?? []) {
        input.addEventListener("midimessage", message);
        attached.add(input);
      }
    }
    void navigator
      .requestMIDIAccess()
      .then((result) => {
        if (disposed) return;
        access = result;
        attach();
        access.addEventListener("statechange", attach);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      access?.removeEventListener("statechange", attach);
      for (const input of attached)
        input.removeEventListener("midimessage", message);
    };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(KEY, JSON.stringify(values));
      } catch {
        /* Optional. */
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [values]);
  return values;
}
// Live observations never mutate documents, navigate out of groups, or consume undo entries.
export function applyMidiValues(
  patch: Patch,
  values: Readonly<Record<string, number>>,
): Patch {
  return {
    ...patch,
    nodes: patch.nodes.map((node) => ({
      ...node,
      ...(node.type === "midiCC"
        ? {
            params: {
              ...node.params,
              value:
                values[
                  `${Math.round(node.params.channel ?? 1)}:${Math.round(node.params.cc ?? 1)}`
                ] ??
                node.params.value ??
                0,
            },
          }
        : {}),
      ...(node.subpatch
        ? { subpatch: applyMidiValues(node.subpatch, values) }
        : {}),
    })),
  };
}

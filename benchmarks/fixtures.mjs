export function fixture(count) {
  const nodes = [
    { id: "system_1", type: "System", params: {}, position: { x: 40, y: 160 } },
    {
      id: "multiply_1",
      type: "Multiply",
      params: { a: 0, b: 80 },
      position: { x: 300, y: 80 },
    },
    {
      id: "sin_1",
      type: "Sin",
      params: { value: 0 },
      position: { x: 520, y: 80 },
    },
    {
      id: "multiply_2",
      type: "Multiply",
      params: { a: 0, b: 40 },
      position: { x: 300, y: 260 },
    },
    {
      id: "sin_2",
      type: "Sin",
      params: { value: 0 },
      position: { x: 520, y: 260 },
    },
    {
      id: "sin_3",
      type: "Sin",
      params: { value: 0 },
      position: { x: 520, y: 440 },
    },
    {
      id: "output_1",
      type: "Output",
      params: { r: 0, g: 0, b: 0 },
      position: { x: 760, y: 210 },
    },
  ];
  const pairs = [
    ["system_1", "x", "multiply_1", "a"],
    ["multiply_1", "value", "sin_1", "value"],
    ["sin_1", "value", "output_1", "r"],
    ["system_1", "y", "multiply_2", "a"],
    ["multiply_2", "value", "sin_2", "value"],
    ["sin_2", "value", "output_1", "g"],
    ["system_1", "time", "sin_3", "value"],
    ["sin_3", "value", "output_1", "b"],
  ];
  const edges = pairs.map(([source, s, target, t], i) => ({
    id: `e${i}`,
    source,
    sourceHandle: `out:${s}`,
    target,
    targetHandle: `in:${t}`,
    weight: 1,
    mode: "set",
  }));
  for (let i = 7; i < count; i++) {
    nodes.push({
      id: `extra_${i}`,
      type: "Multiply",
      params: { a: 0.5, b: 2 },
      position: {
        x: 40 + (i % 10) * 210,
        y: 650 + Math.floor((i - 7) / 10) * 130,
      },
    });
    if (i > 7)
      edges.push({
        id: `extra_e${i}`,
        source: `extra_${i - 1}`,
        sourceHandle: "out:value",
        target: `extra_${i}`,
        targetHandle: "in:a",
        weight: 1,
        mode: "add",
      });
  }
  return {
    version: 1,
    nodes,
    edges,
    ui: {
      patchName: "benchmark",
      sidePanelOpen: true,
      visualizationVisible: true,
      viewport: { x: 10, y: 80, zoom: count === 7 ? 0.85 : 0.32 },
    },
  };
}

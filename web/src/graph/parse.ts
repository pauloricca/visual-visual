import { extractExpressionInputs } from "./expression";
import { NODE_TYPE_LIST } from "./nodeTypes";
import type { Patch, NodeType, LinkMode, PortDefinition } from "./types";

const DEFAULT_EXPRESSION = "a";

export function parsePatchJson(json: string): Patch {
  const parsed = JSON.parse(json) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Patch JSON must be an object.");
  }
  if (!Array.isArray(parsed.nodes)) {
    throw new Error("Patch JSON must contain a nodes array.");
  }
  if (!Array.isArray(parsed.links)) {
    throw new Error("Patch JSON must contain a links array.");
  }

  return {
    ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
    nodes: parsed.nodes.map((node, index) => parsePatchNode(node, index)),
    links: parsed.links.map((link, index) => parsePatchLink(link, index)),
  };
}

function parsePatchNode(value: unknown, index: number): Patch["nodes"][number] {
  if (!isRecord(value)) {
    throw new Error(`Node ${index} must be an object.`);
  }
  if (typeof value.id !== "string" || value.id.trim() === "") {
    throw new Error(`Node ${index} needs a string id.`);
  }
  if (!isNodeType(value.type)) {
    throw new Error(`Node "${value.id}" has an unknown type.`);
  }
  if (!isNumberRecord(value.params)) {
    throw new Error(`Node "${value.id}" needs numeric params.`);
  }
  if (value.expression !== undefined && typeof value.expression !== "string") {
    throw new Error(`Node "${value.id}" expression must be a string.`);
  }
  if (
    value.subpatchName !== undefined &&
    typeof value.subpatchName !== "string"
  ) {
    throw new Error(`Node "${value.id}" subpatchName must be a string.`);
  }
  if (
    value.subpatchCloneId !== undefined &&
    typeof value.subpatchCloneId !== "string"
  ) {
    throw new Error(`Node "${value.id}" subpatchCloneId must be a string.`);
  }

  const position =
    value.position === undefined
      ? undefined
      : parsePosition(value.position, value.id);
  const parsedInputs =
    value.inputs === undefined
      ? undefined
      : parsePortDefinitions(value.inputs, `Node "${value.id}" inputs`);
  const outputs =
    value.outputs === undefined
      ? undefined
      : parsePortDefinitions(value.outputs, `Node "${value.id}" outputs`);
  const subpatch =
    value.subpatch === undefined
      ? undefined
      : parsePatchObject(value.subpatch, `Node "${value.id}" subpatch`);
  const expression =
    value.type === "Expression"
      ? (value.expression ?? DEFAULT_EXPRESSION)
      : value.expression;
  const inputs =
    value.type === "Expression" && expression !== undefined
      ? (parsedInputs ?? expressionInputDefinitions(expression))
      : parsedInputs;
  const params =
    value.type === "Expression" && inputs
      ? syncParamsToInputs(value.params, inputs)
      : value.params;

  return {
    ...(value.enabled === false ? { enabled: false } : {}),
    id: value.id,
    type: value.type,
    ...(value.subpatchName ? { subpatchName: value.subpatchName } : {}),
    ...(value.subpatchCloneId
      ? { subpatchCloneId: value.subpatchCloneId }
      : {}),
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
    if (
      !isRecord(port) ||
      typeof port.name !== "string" ||
      port.name.trim() === ""
    ) {
      throw new Error(`${label} port ${index} needs a string name.`);
    }

    const defaultValue = port.defaultValue;
    if (
      defaultValue !== undefined &&
      (typeof defaultValue !== "number" || !Number.isFinite(defaultValue))
    ) {
      throw new Error(
        `${label} port "${port.name}" defaultValue must be numeric.`,
      );
    }

    const connectable = port.connectable;
    if (connectable !== undefined && typeof connectable !== "boolean") {
      throw new Error(
        `${label} port "${port.name}" connectable must be boolean.`,
      );
    }

    const min = port.min;
    const max = port.max;
    if (
      min !== undefined &&
      (typeof min !== "number" || !Number.isFinite(min))
    ) {
      throw new Error(`${label} port "${port.name}" min must be numeric.`);
    }
    if (
      max !== undefined &&
      (typeof max !== "number" || !Number.isFinite(max))
    ) {
      throw new Error(`${label} port "${port.name}" max must be numeric.`);
    }

    const integer = port.integer;
    if (integer !== undefined && typeof integer !== "boolean") {
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

function parsePatchLink(value: unknown, index: number): Patch["links"][number] {
  if (!isRecord(value)) {
    throw new Error(`Link ${index} must be an object.`);
  }

  const from = parseEndpoint(value.from, `Link ${index} source`);
  const to = parseEndpoint(value.to, `Link ${index} target`);
  const weight = value.weight;
  if (
    weight !== undefined &&
    (typeof weight !== "number" || !Number.isFinite(weight))
  ) {
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
  return value === "set" || value === "add" || value === "multiply";
}

function parseEndpoint(
  value: unknown,
  label: string,
): Patch["links"][number]["from"] {
  if (
    !isRecord(value) ||
    typeof value.node !== "string" ||
    typeof value.port !== "string"
  ) {
    throw new Error(`${label} must contain string node and port values.`);
  }

  return {
    node: value.node,
    port: value.port,
  };
}

function parsePosition(
  value: unknown,
  nodeId: string,
): Patch["nodes"][number]["position"] {
  if (
    !isRecord(value) ||
    typeof value.x !== "number" ||
    typeof value.y !== "number" ||
    !Number.isFinite(value.x) ||
    !Number.isFinite(value.y)
  ) {
    throw new Error(
      `Node "${nodeId}" position must contain numeric x and y values.`,
    );
  }

  return {
    x: value.x,
    y: value.y,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (entry) => typeof entry === "number" && Number.isFinite(entry),
  );
}

function isNodeType(value: unknown): value is NodeType {
  return (
    typeof value === "string" && (NODE_TYPE_LIST as string[]).includes(value)
  );
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
  return Object.fromEntries(
    inputs.map((input) => [
      input.name,
      params[input.name] ?? input.defaultValue ?? 0,
    ]),
  );
}

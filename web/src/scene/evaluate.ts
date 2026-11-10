import { executionGraph } from "./executionAreas";
import {
  effectiveGroupGraph,
  spagbolGroupKinds,
  type GraphDocument,
  type GraphNode,
  type GraphLink,
} from "@pauloricca/spagbol";
import { sceneNodes, entityDefaults, scopeKinds } from "./catalogue";
export interface SceneEntity {
  id: string;
  node: GraphNode;
  values: Record<string, number>;
  visible: boolean;
}
interface State {
  kind: string;
  value: number;
  trigger: number;
  serial: number;
  release?: number;
  reset?: number;
  selected?: string;
  elapsed?: number;
  start?: number;
  initialized?: boolean;
  queued?: number;
  seed?: number;
  births: {
    serial: number;
    time: number;
    tag: number;
    gate: number;
    age: number;
  }[];
}
const finite = (n: number) => (Number.isFinite(n) ? n : 0);
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

// The installed Spagbol package supplies graph semantics/editors but no numeric executor.
// This adapter evaluates its float ports, links, link properties and execution scopes.
export class SceneEvaluator {
  states = new Map<string, State>();
  previous = new Map<string, number>();
  lastTime = 0;
  private groupGraphs = new WeakMap<GraphNode, GraphDocument>();
  private groupGraph(node: GraphNode): GraphDocument {
    if (!Object.isFrozen(node)) return effectiveGroupGraph(node)!;
    let graph = this.groupGraphs.get(node);
    if (!graph) {
      graph = effectiveGroupGraph(node)!;
      this.groupGraphs.set(node, graph);
    }
    return graph;
  }
  evaluate(document: GraphDocument, time: number): SceneEntity[] {
    const delta = Math.max(0, Math.min(0.1, time - this.lastTime));
    this.lastTime = time;
    const entities: SceneEntity[] = [],
      live = new Set<string>(),
      previousKeys = new Set<string>();
    let evaluations = 0;
    interface ScopeResult {
      killed: boolean;
      outputs: Record<string, number>;
    }
    const scope = (
      graph: GraphDocument,
      prefix: string,
      context = { index: 0, count: 1, age: 0, gate: 1 },
      inherited?: Map<string, Record<string, number>>,
      visible = true,
    ): ScopeResult => {
      let killed = false;
      const groups = new Map<string, ScopeResult>();
      const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
      for (const [id] of inherited ?? []) {
        if (!nodes.has(id)) nodes.set(id, { id, kind: "Instance", values: {}, data: {}, position: { x: 0, y: 0 } });
      }
      const cache = new Map<string, number>(),
        pending = new Set<string>();
      const state = (node: GraphNode) => {
        const id = prefix + node.id;
        live.add(id);
        let s = this.states.get(id);
        if (!s || s.kind !== node.kind) {
          s = { kind: node.kind, value: 0, trigger: 0, serial: 0, births: [] };
          this.states.set(id, s);
        }
        return s;
      };
      const resolve = (key: string, compute: () => number): number => {
        previousKeys.add(prefix + key);
        if (cache.has(key)) return cache.get(key)!;
        if (pending.has(key)) return this.previous.get(prefix + key) ?? 0;
        pending.add(key);
        const value = finite(compute());
        pending.delete(key);
        cache.set(key, value);
        this.previous.set(prefix + key, value);
        return value;
      };
      const linkValue = (link: GraphLink): number =>
        resolve("link:" + link.id, () => {
          const source = nodes.get(link.source.nodeId);
          return source
            ? output(source, link.source.portId) *
                combine(
                  link.weight ?? 1,
                  graph.links.filter(
                    (l) =>
                      l.target.type === "link" &&
                      l.target.linkId === link.id &&
                      l.target.property === "weight",
                  ),
                )
            : 0;
        });
      const combine = (base: number, links: GraphLink[]): number => {
        const enabled = links.filter((l) => l.enabled !== false);
        const sets = enabled.filter((l) => l.mode === "set");
        let value = sets.length
          ? sets.reduce((sum, l) => sum + linkValue(l), 0) / sets.length
          : base;
        value += enabled
          .filter((l) => l.mode === "add")
          .reduce((sum, l) => sum + linkValue(l), 0);
        for (const l of enabled.filter((l) => l.mode === "multiply"))
          value *= linkValue(l);
        for (const l of enabled.filter((l) => l.mode === "bend"))
          value *= 2 ** linkValue(l);
        return finite(value);
      };
      const input = (node: GraphNode, port: string): number =>
        resolve(node.id + ":in:" + port, () =>
          combine(
            node.values[port] ??
              sceneNodes
                .get(node.kind)
                ?.ports(node)
                .find((p) => p.id === port && p.direction === "input")
                ?.defaultValue ??
              0,
            graph.links.filter(
              (l) =>
                l.target.type === "port" &&
                l.target.nodeId === node.id &&
                l.target.portId === port,
            ),
          ),
        );
      const output = (node: GraphNode, port: string): number => {
        const parent = inherited?.get(node.id);
        if (parent) return parent[port] ?? 0;
        return resolve(node.id + ":out:" + port, () => {
          if (node.enabled === false) return 0;
          if (node.graph && !scopeKinds.includes(node.kind))
            return runGroup(node).outputs[port] ?? 0;
          const v = (p: string) => input(node, p),
            s = state(node);
          switch (node.kind) {
            case "Scene Time":
              return port === "delta" ? delta : time;
            case "Scene Playhead": {
              const reset = v("reset");
              if (reset > 0 && s.trigger <= 0) s.value = 0;
              s.trigger = reset;
              if (v("playing") > 0) s.value += delta * v("speed");
              const length = Math.max(0.0001, v("length"));
              return v("loop") > 0
                ? ((s.value % length) + length) % length
                : Math.min(length, Math.max(0, s.value));
            }
            case "Instance":
            case "Spread":
            case "Spawn":
            case "Conditional Execution":
              return context[port as keyof typeof context] ?? 0;
            case "Constant":
            case "Pass":
              return v("value");
            case "Button": {
              if (node.data.mode !== "trigger")
                return v("value") >= 0.5 ? 1 : 0;
              const pulses = Math.max(0, Number(node.data.pulses) || 0);
              s.queued = Math.min(
                256,
                (s.queued ?? 0) + Math.max(0, pulses - s.serial),
              );
              s.serial = pulses;
              if (s.value > 0) s.value = 0;
              else if (s.queued > 0) {
                s.queued--;
                s.value = 1;
              }
              return s.value;
            }
            case "Slider":
              return (
                v("min") +
                (v("max") - v("min")) * Math.max(0, Math.min(1, v("value")))
              );
            case "Joystick":
              return (
                v(port + "Min") +
                (v(port + "Max") - v(port + "Min")) *
                  Math.max(0, Math.min(1, v(port)))
              );
            case "Abs":
              return Math.abs(v("value"));
            case "Multiply":
              return v("a") * v("b");
            case "Pow":
              return v("base") ** v("exponent");
            case "Clamp":
              return Math.max(
                Math.min(v("min"), v("max")),
                Math.min(Math.max(v("min"), v("max")), v("value")),
              );
            case "Map":
              if (v("inMax") === v("inMin")) return v("outMin");
              return (
                v("outMin") +
                ((v("value") - v("inMin")) / (v("inMax") - v("inMin"))) *
                  (v("outMax") - v("outMin"))
              );
            case "Selector": {
              const index = Math.floor(v("select")),
                selected = ["a", "b"][index - 1];
              const changed = selected && selected !== s.selected;
              if (changed) {
                s.start = s.value;
                s.elapsed = 0;
                if (!s.selected) s.start = v(selected);
                s.selected = selected;
              } else s.elapsed = (s.elapsed ?? 0) + delta;
              if (!s.selected) return 0;
              const t =
                v("slide") <= 0
                  ? 1
                  : Math.min(1, (s.elapsed ?? 0) / v("slide"));
              s.value = (s.start ?? 0) + (v(s.selected) - (s.start ?? 0)) * t;
              return s.value;
            }
            case "Accumulator": {
              const low = Math.min(v("min"), v("max")),
                high = Math.max(v("min"), v("max"));
              if (!s.initialized) {
                s.value = low;
                s.initialized = true;
              }
              s.value = Math.max(low, Math.min(high, s.value));
              const trigger = v("trigger"),
                reset = v("reset");
              if (reset >= 0.5 && (s.reset ?? 0) < 0.5) s.value = low;
              else if (
                node.data.mode === "continuous" ||
                (trigger >= 0.5 && s.trigger < 0.5)
              ) {
                const next = finite(s.value + v("increment"));
                s.value = next > high ? low : next < low ? high : next;
              }
              s.trigger = trigger;
              s.reset = reset;
              return s.value;
            }
            case "Random": {
              const trigger = v("trigger"),
                seed = v("seed");
              if (s.seed !== seed) {
                s.serial = 0;
                s.seed = seed;
              }
              if (!s.serial || (trigger >= 0.5 && s.trigger < 0.5))
                s.value = hash(seed + s.serial++);
              s.trigger = trigger;
              return v("min") + (v("max") - v("min")) * s.value;
            }
            case "Noise": {
              s.value = hash(++s.serial + (Number(node.data.seed) || 1));
              return v("min") + (v("max") - v("min")) * s.value;
            }
            case "Curve": {
              const points = node.data.points as
                { x: number; y: number }[] | undefined;
              if (!points?.length) return 0;
              const p = boundary(
                v("position"),
                String(node.data.boundary ?? "clamp"),
              );
              const right = points.findIndex((a) => a.x >= p);
              if (right === 0) return points[0].y;
              if (right < 0) return points.at(-1)!.y;
              const a = points[right - 1],
                b = points[right];
              return a.y + ((b.y - a.y) * (p - a.x)) / (b.x - a.x || 1);
            }
            case "Sequence": {
              const steps = Math.max(1, Number(node.data.steps) || 16);
              const p = Math.min(
                steps - Number.EPSILON * steps,
                boundary(v("position"), String(node.data.boundary ?? "clamp")) *
                  steps,
              );
              return (
                (
                  node.data.items as
                    { start: number; end: number; level: number }[] | undefined
                )?.find((a) => p >= a.start && p < a.end)?.level ?? 0
              );
            }
            case "Expression":
              return evaluateExpression(String(node.data.expression ?? "a"), v);
            default:
              return 0;
          }
        });
      };
      const runGroup = (node: GraphNode): ScopeResult => {
        const existing = groups.get(node.id);
        if (existing) return existing;
        // Install a placeholder before following feedback through group inputs.
        groups.set(node.id, { killed: false, outputs: {} });
        const child = this.groupGraph(node);
        const bindings = new Map(inherited);
        for (const boundary of child.nodes.filter(
          (n) => n.kind === spagbolGroupKinds.inputs,
        )) {
          bindings.set(
            boundary.id,
            Object.fromEntries(
              (boundary.ports ?? []).map((port) => [
                port.id,
                input(node, port.id),
              ]),
            ),
          );
        }
        const result = scope(
          child,
          prefix + node.id + "/",
          context,
          bindings,
          visible && node.enabled !== false,
        );
        groups.set(node.id, result);
        return result;
      };
      for (const node of graph.nodes) {
        if (++evaluations > 16384)
          throw new Error(
            "Scene execution limit exceeded: reduce nested instance counts (16,384 nodes per frame).",
          );
        if (node.kind in entityDefaults) {
          const values = Object.fromEntries(
            Object.keys(entityDefaults[node.kind]).map((p) => [
              p,
              input(node, p),
            ]),
          );
          if (entities.length >= 4096)
            throw new Error(
              "Scene entity limit exceeded (4,096). Reduce instance counts.",
            );
          entities.push({
            id: prefix + node.id,
            node,
            values,
            visible: visible && node.enabled !== false,
          });
        } else if (scopeKinds.includes(node.kind) && node.graph) {
          const s = state(node),
            child = this.groupGraph(node);
          if (
            (node.kind === "Conditional Execution" &&
              input(node, "gate") < 0.5) ||
            node.enabled === false
          ) {
            // Freeze evaluation and retain entities hidden, including live spawned instances.
            const childIds = new Set<string>();
            const collect = (g: GraphDocument) => {
              for (const n of g.nodes) {
                childIds.add(n.id);
                if (n.graph) collect(n.graph);
              }
            };
            collect(child);
            const frozen = (this.retained.get(prefix + node.id) ?? []).filter(
              (e) => childIds.has(e.node.id),
            );
            this.retained.set(prefix + node.id, frozen);
            entities.push(...frozen.map((e) => ({ ...e, visible: false })));
            for (const id of this.states.keys())
              if (
                id.startsWith(prefix + node.id + "/") &&
                childIds.has(id.split("/").at(-1)!)
              )
                live.add(id);
            for (const key of this.previous.keys())
              if (key.startsWith(prefix + node.id + "/")) previousKeys.add(key);
            continue;
          }
          const start = entities.length;
          const run = (
            index: number,
            count: number,
            age: number,
            id: string,
            gate = 1,
          ) => {
            const ctx = { index, count, age, gate };
            const parent = new Map(inherited);
            parent.set(node.id, ctx);
            return scope(
              child,
              prefix + node.id + "/" + id + "/",
              ctx,
              parent,
              visible,
            ).killed;
          };
          if (node.kind === "Spread") {
            const count = Math.max(
              0,
              Math.min(1000, Math.floor(input(node, "count"))),
            );
            for (let i = 0; i < count; i++) run(i + 1, count, 0, String(i + 1));
          } else if (node.kind === "Spawn") {
            const trigger = input(node, "trigger"),
              release = input(node, "release"),
              limit = Math.max(
                0,
                Math.min(1000, Math.floor(input(node, "limit"))),
              );
            if (trigger >= 0.5 && s.trigger < 0.5 && s.births.length < limit)
              s.births.push({
                serial: s.serial++,
                time,
                tag: trigger,
                gate: 1,
                age: 0,
              });
            if (release >= 0.5 && (s.release ?? 0) < 0.5)
              for (const birth of s.births)
                if (birth.tag === release) birth.gate = 0;
            s.trigger = trigger;
            s.release = release;
            const lifetime = Math.max(0, input(node, "lifetime"));
            s.births = s.births
              .filter((b) => !lifetime || b.age < lifetime)
              .slice(0, limit);
            const killed = new Set<number>();
            for (const birth of s.births) {
              if (
                run(
                  birth.serial + 1,
                  s.births.length,
                  birth.age,
                  String(birth.serial),
                  birth.gate,
                )
              )
                killed.add(birth.serial);
              birth.age += delta;
            }
            s.births = s.births.filter((b) => !killed.has(b.serial));
          } else run(0, 1, 0, "0");
          this.retained.set(prefix + node.id, entities.slice(start));
        } else if (node.graph) {
          runGroup(node);
        } else {
          if (node.kind === "Instance") {
            const s = state(node),
              kill = input(node, "kill");
            if (kill >= 0.5 && s.trigger < 0.5) killed = true;
            s.trigger = kill;
          }
          for (const p of sceneNodes.get(node.kind)?.ports(node) ?? [])
            if (p.direction === "output") output(node, p.id);
        }
      }
      const outputs: Record<string, number> = {};
      for (const node of graph.nodes.filter(
        (n) => n.kind === spagbolGroupKinds.outputs,
      )) {
        for (const port of node.ports ?? [])
          outputs[port.id] = input(node, port.id);
      }
      return { killed, outputs };
    };
    scope(executionGraph(document), "");
    for (const id of this.states.keys())
      if (!live.has(id)) this.states.delete(id);
    for (const key of this.previous.keys())
      if (!previousKeys.has(key)) this.previous.delete(key);
    for (const key of this.retained.keys())
      if (!live.has(key)) this.retained.delete(key);
    return entities;
  }
  retained = new Map<string, SceneEntity[]>();
}

// A small numeric expression parser; never evaluates JavaScript from a project file.
function boundary(position: number, mode: string): number {
  if (mode === "repeat") return position - Math.floor(position);
  if (mode === "mirror") {
    const p = position - 2 * Math.floor(position / 2);
    return p <= 1 ? p : 2 - p;
  }
  return Math.max(0, Math.min(1, position));
}

export function evaluateExpression(
  source: string,
  variable: (name: string) => number,
): number {
  const tokens =
    source.match(
      /(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?|[A-Za-z_]\w*|[()+\-*/%^,]/gi,
    ) ?? [];
  if (tokens.join("") !== source.replace(/\s/g, "")) return 0;
  let i = 0;
  const functions: Record<string, (...args: number[]) => number> = {
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    abs: Math.abs,
    pow: Math.pow,
    min: Math.min,
    max: Math.max,
    sqrt: Math.sqrt,
    floor: Math.floor,
    ceil: Math.ceil,
    exp: Math.exp,
    log: Math.log,
    fract: (x) => x - Math.floor(x),
    clamp: (x, a, b) => Math.max(a, Math.min(b, x)),
    mix: (a, b, t) => a + (b - a) * t,
  };
  const atom = (): number => {
    const token = tokens[i++];
    if (!token) throw Error();
    if (token === "-") return -atom();
    if (token === "+") return atom();
    if (token === "(") {
      const v = expr(0);
      if (tokens[i++] !== ")") throw Error();
      return v;
    }
    if (/^[\d.]/.test(token)) return Number(token);
    if (tokens[i] === "(") {
      i++;
      const args = [expr(0)];
      while (tokens[i] === ",") {
        i++;
        args.push(expr(0));
      }
      if (tokens[i++] !== ")") throw Error();
      return functions[token]?.(...args) ?? 0;
    }
    return token === "pi" ? Math.PI : variable(token);
  };
  const precedence: Record<string, number> = {
    "+": 1,
    "-": 1,
    "*": 2,
    "/": 2,
    "%": 2,
    "^": 3,
  };
  const expr = (min: number): number => {
    let left = atom();
    while ((precedence[tokens[i]] ?? -1) >= min) {
      const op = tokens[i++],
        right = expr(precedence[op] + (op === "^" ? 0 : 1));
      left =
        op === "+"
          ? left + right
          : op === "-"
            ? left - right
            : op === "*"
              ? left * right
              : op === "/"
                ? left / right
                : op === "%"
                  ? left % right
                  : left ** right;
    }
    return left;
  };
  try {
    const value = expr(0);
    return i === tokens.length ? finite(value) : 0;
  } catch {
    return 0;
  }
}

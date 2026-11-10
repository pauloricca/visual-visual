// Painty v1: painty/docs/bmpy-format.md. Keep this reader independent of Painty's UI.
export const MAX_PAINTY_FILE_BYTES = 146_800_640;
const MAX_PIXEL_BYTES = 100_663_296;
type RecordValue = Record<string, unknown>;
export interface PaintyRotation { x: number; y: number; z: number }
export interface PaintyLayer {
  id: string;
  name: string;
  visible: boolean;
  depth: number;
  position: { x: number; y: number };
  rotation: PaintyRotation;
  pixels: Uint8Array;
}
export interface PaintyDocument {
  width: number;
  height: number;
  rotation: PaintyRotation;
  position: PaintyRotation;
  perspective: number;
  layers: PaintyLayer[];
}
export function paintyLayerVisible(layer: Pick<PaintyLayer, "id" | "visible">, overrides: unknown): boolean {
  if (overrides && typeof overrides === "object" && !Array.isArray(overrides) && Object.hasOwn(overrides, layer.id)) {
    const value = (overrides as Record<string, unknown>)[layer.id];
    if (typeof value === "boolean") return value;
  }
  return layer.visible;
}
function invalid(field: string): never {
  throw new Error(`Invalid Painty file: ${field}.`);
}
function record(value: unknown, field: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field);
  return value as RecordValue;
}
function number(value: unknown, field: string, min: number, max: number, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) invalid(field);
  return value;
}
function string(value: unknown, field: string): string {
  if (typeof value !== "string") invalid(field);
  return value;
}
function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalid(field);
  return value;
}
function vector(value: unknown, field: string, bound: number): PaintyRotation {
  const v = record(value, field);
  return {
    x: number(v.x, `${field}.x`, -bound, bound),
    y: number(v.y, `${field}.y`, -bound, bound),
    z: number(v.z, `${field}.z`, -bound, bound),
  };
}
export function parsePainty(source: string): PaintyDocument {
  // UTF-8 uses at least one byte per UTF-16 code unit for valid JSON files.
  if (source.length > MAX_PAINTY_FILE_BYTES) invalid("file exceeds 140 MiB");
  let value: unknown;
  try { value = JSON.parse(source); } catch { invalid("malformed JSON"); }
  const root = record(value, "document");
  if (root.format !== "painty") invalid("expected format painty");
  if (root.version !== 1) invalid("unsupported version (expected 1)");
  const width = number(root.width, "width", 1, 4096, true);
  const height = number(root.height, "height", 1, 4096, true);
  const doc = record(root.document, "document");
  if (!Array.isArray(doc.layers) || doc.layers.length < 1 || doc.layers.length > 64) invalid("expected 1–64 layers");
  const bytes = width * height * 4;
  if (bytes * doc.layers.length > MAX_PIXEL_BYTES) invalid("pixels exceed 96 MiB");
  const settings = record(root.settings, "settings");
  const color = (value: unknown, field: string) => {
    if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value)) invalid(field);
  };
  color(settings.fg, "settings.fg");
  color(settings.bg, "settings.bg");
  if (!Array.isArray(settings.palette) || settings.palette.length < 1 || settings.palette.length > 256) invalid("settings.palette");
  for (const column of settings.palette) {
    if (!Array.isArray(column) || column.length !== 3) invalid("settings.palette column");
    column.forEach((c) => color(c, "settings.palette color"));
  }
  if (!Array.isArray(settings.tiles) || settings.tiles.length !== 10) invalid("settings.tiles");
  for (const tile of settings.tiles)
    if (!Array.isArray(tile) || tile.length !== 64 || tile.some((v) => v !== 0 && v !== 1)) invalid("settings.tiles pattern");
  number(settings.selected, "settings.selected", 0, 9, true);
  if (![1, 2, 4, 8, 16].includes(settings.scale as number)) invalid("settings.scale");
  boolean(settings.transparent, "settings.transparent");
  boolean(doc.layersEnabled, "document.layersEnabled");
  const activeId = string(doc.activeId, "document.activeId");
  const rotation = vector(doc.rotation, "document.rotation", 360);
  const position = doc.position === undefined ? { x: 0, y: 0, z: 0 } : vector(doc.position, "document.position", 4096);
  const perspective = doc.perspective === undefined ? 0 : number(doc.perspective, "document.perspective", 0, 1000);
  const ids = new Set<string>();
  // Validate ALL metadata and encoded lengths before allocating any pixel buffers.
  const encoded = doc.layers.map((entry, index) => {
    const field = `layer ${index + 1}`, layer = record(entry, field);
    const id = string(layer.id, `${field} id`);
    if (ids.has(id)) invalid(`${field} duplicate id`);
    ids.add(id);
    const name = string(layer.name, `${field} name`);
    if (name.length > 80) invalid(`${field} name exceeds 80 characters`);
    const visible = boolean(layer.visible, `${field} visible`);
    const depth = number(layer.depth, `${field} depth`, -4096, 4096);
    const rotation = vector(layer.rotation, `${field} rotation`, 360);
    const pos = layer.position === undefined ? { x: 0, y: 0 } : record(layer.position, `${field} position`);
    const position = {
      x: number(pos.x, `${field} position.x`, -4096, 4096),
      y: number(pos.y, `${field} position.y`, -4096, 4096),
    };
    const pixels = string(layer.pixels, `${field} pixels`);
    const padding = (3 - bytes % 3) % 3;
    if (pixels.length !== 4 * Math.ceil(bytes / 3) ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(pixels) ||
        (padding ? !pixels.endsWith("=".repeat(padding)) || pixels[pixels.length - padding - 1] === "=" : pixels.includes("=")))
      invalid(`${field} RGBA Base64 length or encoding`);
    return { id, name, visible, depth, rotation, position, pixels };
  });
  if (!ids.has(activeId)) invalid("active layer does not exist");
  return { width, height, rotation, position, perspective, layers: encoded.map((layer) => {
    const binary = atob(layer.pixels);
    if (binary.length !== bytes) invalid("decoded pixel length");
    const pixels = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) pixels[i] = binary.charCodeAt(i);
    return { ...layer, pixels };
  }) };
}

export async function readPaintyFile(file: Blob): Promise<PaintyDocument> {
  if (file.size > MAX_PAINTY_FILE_BYTES) invalid("file exceeds 140 MiB");
  return parsePainty(await file.text());
}

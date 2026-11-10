import { useState } from "react";
import { storeAsset } from "./assets";
import { readPaintyFile } from "./painty";
import { PaintyLayers } from "./PaintyLayers";
import {
  defineNodeView,
  SpagbolControlSlider,
  SpagbolControlButton,
  SpagbolControlJoystick,
  SpagbolCurveEditor,
  SpagbolSequencer,
  type SpagbolNodeViewProps,
  type SpagbolCurveEditorPoint,
  type SpagbolSequencerItem,
} from "@pauloricca/spagbol";
import { sceneDefinitions, entityDefaults, scopeKinds } from "./catalogue";
function Body({
  node,
  patchData,
  setValue,
  readOnly,
  beginGesture,
  endGesture,
}: SpagbolNodeViewProps) {
  const kind = node.kind;
  const [assetError, setAssetError] = useState("");
  const field = (key: string, placeholder: string) => (
    <input
      aria-label={`${kind} ${key}`}
      placeholder={placeholder}
      value={String(node.data[key] ?? "")}
      onChange={(e) => patchData({
        [key]: e.target.value,
        ...(kind === "Painty" && key === "url" ? { paintyLayerVisibility: {} } : {}),
      })}
    />
  );
  const select = (key: string, choices: string[]) => (
    <label>
      {key}
      <select
        aria-label={`${kind} ${key}`}
        value={String(node.data[key] ?? choices[0])}
        onChange={(e) => patchData({ [key]: e.target.value })}
      >
        {choices.map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
    </label>
  );
  const points = (node.data.points ?? [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
  ]) as unknown as SpagbolCurveEditorPoint[];
  const items = (node.data.items ?? []) as unknown as SpagbolSequencerItem[];
  const setItems = (next: SpagbolSequencerItem[]) =>
    patchData({ items: next.map((item) => ({ ...item })) });
  return (
    <fieldset
      disabled={readOnly}
      className="scene-config nodrag nopan nowheel"
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {[
        "Mesh",
        "Painty",
        "Image",
        "Video",
        "Background",
        "Environment Map",
        "Plane",
        "Box",
        "Sphere",
        "Cylinder",
      ].includes(kind) && (
        <>
          {field(
            "url",
            kind === "Mesh"
              ? "GLTF / GLB URL"
              : kind === "Painty"
                ? "Painty .bmpy URL"
              : kind === "Video"
                ? "Video URL"
                : "Image / texture URL",
          )}
          <input
            aria-label={`${kind} file`}
            type="file"
            accept={
              kind === "Mesh"
                ? ".glb,.gltf"
                : kind === "Painty"
                  ? ".bmpy,application/x-bmpy"
                : kind === "Video"
                  ? "video/*"
                  : "image/*"
            }
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file)
                void (async () => {
                  if (kind === "Painty") await readPaintyFile(file);
                  return storeAsset(file);
                })()
                  .then((url) => {
                    patchData({ url, ...(kind === "Painty" ? { paintyLayerVisibility: {} } : {}) });
                    setAssetError("");
                  })
                  .catch((error) => setAssetError(String(error)));
            }}
          />
          {assetError && <small role="alert">{assetError}</small>}
        </>
      )}
      {kind === "Painty" && (
        <PaintyLayers
          source={String(node.data.url ?? "")}
          visibility={node.data.paintyLayerVisibility}
          onChange={(id, visible) => patchData({
            paintyLayerVisibility: {
              ...(node.data.paintyLayerVisibility as Record<string, boolean> ?? {}),
              [id]: visible,
            },
          })}
        />
      )}
      {["Plane", "Box", "Sphere", "Cylinder", "Mesh"].includes(kind) &&
        select("material", ["standard", "basic", "physical"])}
      {kind === "Mesh" && (
        <label>
          <input
            type="checkbox"
            checked={node.data.overrideMaterial === true}
            onChange={(e) => patchData({ overrideMaterial: e.target.checked })}
          />
          Override materials
        </label>
      )}
      {["Plane", "Box", "Sphere", "Cylinder"].includes(kind) &&
        select("quality", ["normal", "high"])}
      {kind in entityDefaults &&
        !["Fog", "Background", "Environment Map", "Render Settings"].includes(
          kind,
        ) && (
          <label>
            <input
              type="checkbox"
              checked={kind === "Painty" ? node.data.shadows !== false : node.data.shadows === true}
              onChange={(e) => patchData({ shadows: e.target.checked })}
            />
            Shadows
          </label>
        )}
      {kind === "Background" && select("mapping", ["flat", "equirectangular"])}
      {["Directional Light", "Point Light", "Spot Light"].includes(kind) && (
        <label title="Shadow map resolution. Higher values use more GPU memory and rendering time.">
          Shadow resolution
          <select
            aria-label={`${kind} shadow resolution`}
            value={String(node.data.shadowResolution ?? 1024)}
            onChange={(e) => patchData({ shadowResolution: Number(e.target.value) })}
          >
            {[256, 512, 1024, 2048].map((size) => (
              <option key={size} value={size}>{size}</option>
            ))}
          </select>
        </label>
      )}
      {["Image", "Video"].includes(kind) &&
        select("filtering", ["linear", "nearest"])}
      {kind === "Video" && (
        <label>
          <input
            type="checkbox"
            checked={node.data.loop !== false}
            onChange={(e) => patchData({ loop: e.target.checked })}
          />
          Loop video
        </label>
      )}
      {kind === "Text" && (
        <>
          {field("text", "Text")}
          {field("font", "CSS font family")}
        </>
      )}
      {kind === "Button" && select("mode", ["temporary", "toggle", "trigger"])}
      {kind === "Accumulator" && select("mode", ["trigger", "continuous"])}
      {["Curve", "Sequence"].includes(kind) &&
        select("boundary", ["clamp", "repeat", "mirror"])}
      {kind === "Fog" && select("mode", ["exponential", "linear"])}
      {kind === "Render Settings" &&
        select("toneMapping", ["aces", "none", "reinhard"])}
      {kind === "Expression" && field("expression", "sin(a)")}
      {kind === "Slider" && (
        <SpagbolControlSlider
          direction="horizontal"
          value={node.values.value ?? 0.5}
          onChange={(v) => setValue("value", v)}
          onGestureStart={() => beginGesture()}
          onGestureEnd={(cancel) => endGesture(cancel)}
        />
      )}
      {kind === "Button" && (
        <SpagbolControlButton
          mode={
            node.data.mode === "toggle"
              ? "toggle"
              : node.data.mode === "trigger"
                ? "trigger"
                : "temporary"
          }
          pressed={node.values.value ?? 0}
          onPressedChange={(v) => setValue("value", v)}
          onClickPulse={() =>
            patchData({ pulses: Number(node.data.pulses ?? 0) + 1 })
          }
        />
      )}
      {kind === "Joystick" && (
        <SpagbolControlJoystick
          x={node.values.x ?? 0.5}
          y={node.values.y ?? 0.5}
          onChange={(x, y) => {
            setValue("x", x);
            setValue("y", y);
          }}
        />
      )}
      {kind === "Curve" && (
        <SpagbolCurveEditor
          points={points}
          displaySize={{ width: 300, height: 128 }}
          onInsertPoint={(point) => {
            if (points.some((p) => Math.abs(p.x - point.x) < 0.001))
              return null;
            const next = [...points, point].sort((a, b) => a.x - b.x);
            patchData({ points: next.map((p) => ({ ...p })) });
            return next.indexOf(point);
          }}
          onMovePoint={(index, point) =>
            patchData({
              points: points.map((p, i) => ({
                ...(i === index
                  ? {
                      ...point,
                      x:
                        index === 0
                          ? 0
                          : index === points.length - 1
                            ? 1
                            : point.x,
                    }
                  : p),
              })),
            })
          }
          onRemovePoint={(index) => {
            if (index === 0 || index === points.length - 1) return;
            patchData({
              points: points
                .filter((_, i) => i !== index)
                .map((p) => ({ ...p })),
            });
          }}
        />
      )}
      {kind === "Sequence" && (
        <SpagbolSequencer
          ariaLabel="Scene sequence"
          rows={1}
          steps={16}
          rowLabel={() => "value"}
          itemsForRow={() => items}
          onCreateItem={(_, start, end) =>
            setItems([
              ...items,
              {
                id: Math.max(0, ...items.map((i) => i.id)) + 1,
                start,
                end,
                level: 1,
              },
            ])
          }
          onUpdateItem={(_, id, update) =>
            setItems(
              items.map((item) =>
                item.id === id ? { ...item, ...update } : item,
              ),
            )
          }
          onDeleteItem={(_, id) =>
            setItems(items.filter((item) => item.id !== id))
          }
        />
      )}
    </fieldset>
  );
}
export const sceneViews = Object.fromEntries(
  sceneDefinitions.map((def) => [
    def.kind,
    defineNodeView({
      ...(scopeKinds.includes(def.kind) ? {} : { body: Body }),
      minWidth: ["Curve", "Sequence"].includes(def.kind) ? 320 : 180,
      autoWidth: true,
      resizable: true,
    }),
  ]),
);

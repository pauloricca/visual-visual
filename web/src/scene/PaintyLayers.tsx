import { useEffect, useState } from "react";
import { loadPaintyAsset } from "./paintyAsset";
import { paintyLayerVisible, type PaintyLayer } from "./painty";

type Layer = Pick<PaintyLayer, "id" | "name" | "visible">;
export function PaintyLayers({ source, visibility, onChange }: {
  source: string;
  visibility: unknown;
  onChange(id: string, visible: boolean): void;
}) {
  const [loaded, setLoaded] = useState<{ source: string; layers?: Layer[]; error?: string }>();
  useEffect(() => {
    if (!source) return;
    const controller = new AbortController();
    void loadPaintyAsset(source, controller.signal).then(
      (document) => {
        if (!controller.signal.aborted)
          setLoaded({ source, layers: document.layers.map(({ id, name, visible }) => ({ id, name, visible })) });
      },
      (error) => {
        if (!controller.signal.aborted) setLoaded({ source, error: String(error) });
      },
    );
    return () => controller.abort();
  }, [source]);
  if (!source) return null;
  if (loaded?.source !== source) return <small role="status">Loading layers…</small>;
  if (loaded.error) return <small role="alert">{loaded.error}</small>;
  return (
    <fieldset className="painty-layers">
      <legend>Layers</legend>
      {loaded.layers?.map((layer, index) => {
        const name = layer.name || `Layer ${index + 1}`;
        return (
          <label key={layer.id} title={name}>
            <input
              type="checkbox"
              aria-label={`Painty layer ${name}`}
              checked={paintyLayerVisible(layer, visibility)}
              onChange={(event) => onChange(layer.id, event.target.checked)}
            />
            <span>{name}</span>
          </label>
        );
      })}
    </fieldset>
  );
}

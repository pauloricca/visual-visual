import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  GraphEditor,
  SpagbolCanvas,
  useEditorSnapshot,
  graphAt,
  spagbolGroupKinds,
  type GraphDocument,
  type SpagbolCanvasAction,
} from "@pauloricca/spagbol";
import type { ReactFlowInstance, Viewport } from "@xyflow/react";
import { compilePatchToGlsl } from "../graph/glsl";
import { validatePatch } from "../graph/validate";
import { patchToJson } from "../graph/serialize";
import { parsePatchJson } from "../graph/parse";
import { demoPatch } from "../graph/demoPatch";
import type { Patch } from "../graph/types";
import { ExportPanel } from "../export/ExportPanel";
import {
  renderBundleFromCompileResult,
  renderBundleRevision,
} from "../render/renderBundle";
import {
  ensureRenderSyncAppIdInUrl,
  useRenderSyncPublisher,
} from "../sync/renderSync";
import {
  graphToPatch,
  patchToGraph,
  readEditorState,
  shaderNodes,
  normalizeShaderDocument,
  STORAGE_KEY,
  type EditorUi,
} from "./patchCodec";
import { shaderViews } from "./ShaderViews";
import { WebGLPreview, type WebGLPreviewHandle } from "./WebGLPreview";
import {
  canUseLocalPatchStorage,
  fetchLocalPatchLibrary,
  fetchLocalPatchVersion,
  selectInitialLocalPatch,
  saveLocalPatchVersion,
  type LocalPatchEntry,
} from "./patchStorage";
import { useMidi, applyMidiValues, MidiValuesContext } from "./useMidi";

const shaderCanvasFeatures = Object.freeze({
  compact: false,
  areas: false,
  panels: false,
  nestedGraphs: true,
  linkProperties: false,
});

function download(name: string, content: string) {
  const url = URL.createObjectURL(
    new Blob([content], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function candidates(
  patch: Patch,
  path = patch.name ?? "patch",
): { name: string; patch: Patch }[] {
  return patch.nodes.flatMap((node) =>
    node.subpatch
      ? [
          {
            name: `${path} / ${node.subpatchName ?? node.id}`,
            patch: node.subpatch,
          },
          ...candidates(
            node.subpatch,
            `${path} / ${node.subpatchName ?? node.id}`,
          ),
        ]
      : [],
  );
}
export function NodeEditor() {
  const [initial] = useState(readEditorState);
  const runtimeListener = useRef<((document: GraphDocument) => void) | null>(
    null,
  );
  const [editor] = useState(
    () =>
      new GraphEditor({
        nodes: shaderNodes,
        document: initial?.document ?? patchToGraph(demoPatch),
        policy: {
          modes: ["set", "add", "multiply"],
          linkProperties: [],
          allowSelfLinks: true,
        },
        historyLimit: 100,
        normalizeDocument: normalizeShaderDocument,
        onCommit: (event) => {
          if (event.kinds.some((kind) => kind !== "layout"))
            runtimeListener.current?.(event.document);
        },
        onPreview: (event) => {
          if (!event || event.kinds.some((kind) => kind !== "layout"))
            runtimeListener.current?.(
              event?.document ?? editor.getSnapshot().document,
            );
        },
      }),
  );
  const snapshot = useEditorSnapshot(editor);
  const [runtimeDocument, setRuntimeDocument] = useState(
    editor.getSnapshot().document,
  );
  runtimeListener.current = setRuntimeDocument;
  const [patchName, setPatchName] = useState(
    initial?.ui?.patchName ?? "untitled-patch",
  );
  const [sidePanelOpen, setSidePanelOpen] = useState(
    initial?.ui?.sidePanelOpen ?? true,
  );
  const [visualizationVisible, setVisualizationVisible] = useState(
    initial?.ui?.visualizationVisible ?? true,
  );
  const [uiHidden, setUiHidden] = useState(false);
  const [fps, setFps] = useState(0);
  const [importError, setImportError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [library, setLibrary] = useState<LocalPatchEntry[] | null>(null);
  const [selectedPatch, setSelectedPatch] = useState("");
  const [selectedVersion, setSelectedVersion] = useState("");
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [subpatches, setSubpatches] = useState<ReturnType<
    typeof candidates
  > | null>(null);
  const [flow, setFlow] = useState<ReactFlowInstance | null>(null);
  const preview = useRef<WebGLPreviewHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const viewport = useRef<Viewport>(
    initial?.ui?.viewport ?? { x: 0, y: 0, zoom: 1 },
  );
  const [appId] = useState(ensureRenderSyncAppIdInUrl);
  const local = canUseLocalPatchStorage();
  const midi = useMidi();
  // Document identity stays stable through selection and viewport updates.
  const patch = useMemo(
    () => applyMidiValues(graphToPatch(runtimeDocument), midi),
    [runtimeDocument, midi],
  );
  const validation = useMemo(() => validatePatch(patch), [patch]);
  const compile = useMemo(
    () => compilePatchToGlsl(patch, "webgl2", { enableScopes: !uiHidden }),
    [patch, uiHidden],
  );
  const projector = useMemo(
    () => compilePatchToGlsl(patch, "webgl2", { enableScopes: false }),
    [patch],
  );
  const json = useMemo(
    () => patchToJson({ ...patch, name: patchName }),
    [patch, patchName],
  );
  const bundle = useMemo(
    () =>
      renderBundleFromCompileResult(
        projector,
        patchName,
        renderBundleRevision(json),
      ),
    [projector, patchName, json],
  );
  useRenderSyncPublisher(bundle, appId);
  const presentation = useMemo(() => {
    const graph = graphAt(runtimeDocument, snapshot.path);
    const nestedPatch = graphToPatch(graph);
    const prefix = snapshot.path.length ? `${snapshot.path.join("__")}__` : "";
    return Object.fromEntries(
      nestedPatch.links.map((link, index) => {
        const id = `${prefix}${link.from.node}:${link.from.port}->${prefix}${link.to.node}:${link.to.port}`;
        return [
          graph.links[index].id,
          {
            feedback: compile.feedbackLinkIds.includes(id),
            control: compile.delayFrameLinkIds.includes(id),
          },
        ];
      }),
    );
  }, [
    runtimeDocument,
    snapshot.path,
    compile.feedbackLinkIds,
    compile.delayFrameLinkIds,
  ]);
  const persist = useCallback(
    (nextViewport?: Viewport) => {
      if (nextViewport) viewport.current = nextViewport;
      const ui: EditorUi = {
        patchName,
        sidePanelOpen,
        visualizationVisible,
        viewport: viewport.current,
      };
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ document: editor.getSnapshot().document, ui }),
        );
      } catch {
        /* Optional browser storage. */
      }
    },
    [editor, patchName, sidePanelOpen, visualizationVisible],
  );
  useEffect(() => {
    const id = setTimeout(persist, 120);
    return () => clearTimeout(id);
  }, [persist, snapshot.document]);
  useEffect(() => {
    const save = () => persist();
    window.addEventListener("pagehide", save);
    return () => window.removeEventListener("pagehide", save);
  }, [persist]);
  const viewportTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const viewportChanged = useCallback(
    (value: Viewport) => {
      viewport.current = value;
      clearTimeout(viewportTimer.current);
      viewportTimer.current = setTimeout(() => persist(), 120);
    },
    [persist],
  );
  useEffect(() => () => clearTimeout(viewportTimer.current), []);
  const fit = useCallback(() => {
    requestAnimationFrame(() => {
      void flow?.fitView({ padding: 0.2, duration: 0 });
    });
  }, [flow]);
  useEffect(() => {
    if (flow && !initial?.ui?.viewport) {
      const id = setTimeout(fit, 100);
      return () => clearTimeout(id);
    }
  }, [flow, initial, fit]);
  const loadPatch = (next: Patch) => {
    editor.setMode("edit");
    editor.replace(patchToGraph(next));
    setPatchName(next.name ?? "untitled-patch");
    setImportError(null);
    setLibrary(null);
    setSubpatches(null);
    fit();
  };
  const act = (fn: () => void | Promise<void>) => async () => {
    try {
      await fn();
      setImportError(null);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    }
  };
  const save = act(async () => {
    const exported = patchToJson({
      ...applyMidiValues(graphToPatch(editor.getSnapshot().document), midi),
      name: patchName,
    });
    if (local) await saveLocalPatchVersion(patchName, exported);
    else download(`${patchName.trim() || "untitled-patch"}.json`, exported);
    setSaved(true);
    setTimeout(() => setSaved(false), 1000);
  });
  const openLibrary = async (asSubpatch = false) => {
    setImporting(asSubpatch);
    if (!local) {
      fileInput.current?.click();
      return;
    }
    setLoading(true);
    setLibrary([]);
    try {
      const entries = await fetchLocalPatchLibrary();
      setLibrary(entries);
      const first = selectInitialLocalPatch(entries, patchName);
      setSelectedPatch(first?.name ?? "");
      setSelectedVersion(first?.versions[0]?.id ?? "");
    } catch (error) {
      setImportError(String(error));
    } finally {
      setLoading(false);
    }
  };
  const chooseImported = (next: Patch) => {
    const choices = candidates(next);
    if (!choices.length) throw new Error("This patch contains no subpatches.");
    setSubpatches(choices);
    setLibrary(null);
  };
  const loadSelected = act(async () => {
    const next = parsePatchJson(
      await fetchLocalPatchVersion(selectedPatch, selectedVersion),
    );
    if (importing) chooseImported(next);
    else loadPatch(next);
  });
  const importSubpatch = (entry: { name: string; patch: Patch }) => {
    const node = shaderNodes.create(
      spagbolGroupKinds.group,
      flow?.screenToFlowPosition({ x: 300, y: 200 }) ?? { x: 100, y: 100 },
    );
    node.label = entry.name.split(" / ").at(-1);
    node.graph = patchToGraph(entry.patch);
    node.ports = node.graph.nodes
      .filter(
        (boundary) =>
          boundary.kind === spagbolGroupKinds.inputs ||
          boundary.kind === spagbolGroupKinds.outputs,
      )
      .flatMap((boundary) =>
        (boundary.ports ?? []).map((port) => ({
          ...port,
          direction:
            boundary.kind === spagbolGroupKinds.inputs
              ? ("input" as const)
              : ("output" as const),
        })),
      );
    editor.edit("Import subpatch", "structure", (graph) => {
      graph.nodes.push(node);
    });
    setSubpatches(null);
  };
  const fullscreen = () => {
    if (document.fullscreenElement) return document.exitFullscreen();
    return document.documentElement.requestFullscreen();
  };
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (
        (event.target as HTMLElement)?.closest(
          "input, textarea, select, [contenteditable]",
        )
      )
        return;
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (["s", "u", "f"].includes(key)) {
        event.preventDefault();
        if (key === "s") setVisualizationVisible((value) => !value);
        if (key === "u") setUiHidden((value) => !value);
        if (key === "f") void fullscreen();
      }
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setNewOpen(false);
        setLibrary(null);
        setSubpatches(null);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const currentGroup = snapshot.path.length
    ? graphAt(snapshot.document, snapshot.path.slice(0, -1)).nodes.find(
        (node) => node.id === snapshot.path.at(-1),
      )
    : undefined;
  const buttons: SpagbolCanvasAction[] = [
    {
      id: "new",
      label: "NEW",
      ariaLabel: "New empty patch",
      onSelect: () => setNewOpen(true),
    },
    {
      id: "save",
      label: saved ? "SAVED" : "SAVE",
      ariaLabel: local ? "Save patch to patches directory" : "Save patch JSON",
      disabled: local && !patchName.trim(),
      onSelect: save,
    },
    {
      id: "load",
      label: "LOAD",
      ariaLabel: local
        ? "Load patch from patches directory"
        : "Load patch JSON",
      onSelect: () => openLibrary(),
    },
  ];
  return (
    <MidiValuesContext.Provider value={midi}>
      <main
        className={[
          "app-shell",
          sidePanelOpen && !uiHidden ? "" : "app-shell-panel-closed",
          uiHidden ? "app-shell-ui-hidden" : "",
          visualizationVisible ? "" : "app-shell-visual-hidden",
        ].join(" ")}
        onPointerDownCapture={(event) => {
          if (uiHidden) {
            event.preventDefault();
            event.stopPropagation();
            setUiHidden(false);
          }
        }}
      >
        <WebGLPreview
          ref={preview}
          active={visualizationVisible}
          fragmentShader={compile.shaderCode}
          shaderArgs={compile.shaderArgs}
          feedbackTextureCount={compile.feedbackTextureCount}
          bufferSlots={compile.bufferSlots}
          delaySlots={compile.delaySlots}
          envelopeSlots={compile.envelopeSlots}
          scopeSlots={compile.scopeSlots}
          meterSlots={compile.meterSlots}
          mediaRequirements={compile.media}
          onFpsChange={setFps}
        />
        <section
          className="editor-shell"
          onKeyDownCapture={(event) => {
            if (
              event.key.toLowerCase() === "x" &&
              !event.metaKey &&
              !event.ctrlKey &&
              !(event.target as HTMLElement).closest(
                "input, textarea, select, [contenteditable]",
              )
            )
              event.stopPropagation();
          }}
        >
          <SpagbolCanvas
            editor={editor}
            views={shaderViews}
            linkPresentation={presentation}
            className="visual-graph"
            defaultViewport={initial?.ui?.viewport}
            onInit={setFlow}
            onViewportChange={viewportChanged}
            features={shaderCanvasFeatures}
            controls={{
              buttons,
              leading: (
                <input
                  className="patch-name-input"
                  aria-label={currentGroup ? "Subpatch name" : "Patch name"}
                  value={
                    currentGroup ? (currentGroup.label ?? "Group") : patchName
                  }
                  onChange={(event) => {
                    const name = event.target.value;
                    if (currentGroup)
                      editor.edit("Rename subpatch", "metadata", (graph) => {
                        graph.data = { ...graph.data, name };
                      });
                    else setPatchName(name);
                  }}
                />
              ),
              zoomExtra: <span className="fps-badge">{fps} FPS</span>,
              menuItems: [
                {
                  id: "import",
                  label: "IMPORT SUBPATCH",
                  onSelect: () => openLibrary(true),
                },
                {
                  id: "screenshot",
                  label: "SAVE SCREENSHOT",
                  onSelect: () => preview.current?.downloadScreenshot(),
                },
                {
                  id: "glsl",
                  label: "TOGGLE GLSL",
                  ariaLabel: "Toggle GLSL panel",
                  checked: sidePanelOpen,
                  onSelect: () => setSidePanelOpen((value) => !value),
                },
                {
                  id: "visuals",
                  label: "TOGGLE VISUALS",
                  ariaLabel: "Toggle visuals",
                  checked: visualizationVisible,
                  onSelect: () => setVisualizationVisible((value) => !value),
                },
                {
                  id: "fullscreen",
                  label: "TOGGLE FULLSCREEN",
                  onSelect: fullscreen,
                },
                {
                  id: "ui",
                  label: "TOGGLE UI",
                  onSelect: () => setUiHidden(true),
                },
              ],
            }}
          />
          <input
            className="panel-file-input"
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file)
                void act(async () => {
                  const next = parsePatchJson(await file.text());
                  if (importing) chooseImported(next);
                  else loadPatch(next);
                })();
            }}
          />
          {importError && !sidePanelOpen ? (
            <p className="editor-error" role="alert">
              {importError}
            </p>
          ) : null}
        </section>
        {sidePanelOpen && !uiHidden ? (
          <ExportPanel
            shaderCode={compile.shaderCode}
            validation={validation}
            compileErrors={compile.errors}
            importError={importError}
          />
        ) : null}
        {newOpen ? (
          <div className="import-modal-backdrop">
            <section
              className="import-modal confirm-modal"
              role="dialog"
              aria-modal="true"
              aria-label="New patch"
            >
              <h2>New empty patch?</h2>
              <p>Save your current patch first if you want to keep it.</p>
              <footer className="import-modal-actions">
                <button onClick={() => setNewOpen(false)}>Cancel</button>
                <button
                  onClick={() => {
                    loadPatch({
                      name: "untitled-patch",
                      nodes: [
                        demoPatch.nodes[0],
                        {
                          ...demoPatch.nodes.at(-1)!,
                          position: { x: 960, y: 160 },
                        },
                      ],
                      links: [],
                    });
                    setNewOpen(false);
                  }}
                >
                  New patch
                </button>
              </footer>
            </section>
          </div>
        ) : null}
        {library ? (
          <div className="import-modal-backdrop">
            <section
              className="import-modal local-patch-modal"
              role="dialog"
              aria-modal="true"
              aria-label={importing ? "Import subpatch" : "Load patch"}
            >
              <header className="import-modal-header">
                <h2>{importing ? "Import subpatch" : "Load patch"}</h2>
                <button onClick={() => setLibrary(null)}>X</button>
              </header>
              {loading ? (
                <p>Reading saved patches…</p>
              ) : (
                <div className="local-patch-browser">
                  <section className="local-patch-column">
                    <h3>PATCH</h3>
                    <div className="local-patch-list">
                      {library.map((entry) => (
                        <button
                          key={entry.name}
                          className={`local-patch-option ${entry.name === selectedPatch ? "local-patch-option-selected" : ""}`}
                          onClick={() => {
                            setSelectedPatch(entry.name);
                            setSelectedVersion(entry.versions[0]?.id ?? "");
                          }}
                        >
                          {entry.name}
                          <span>{entry.versionCount}</span>
                        </button>
                      ))}
                    </div>
                  </section>
                  <section className="local-patch-column">
                    <h3>VERSION</h3>
                    <div className="local-patch-list">
                      {library
                        .find((entry) => entry.name === selectedPatch)
                        ?.versions.map((version) => (
                          <button
                            key={version.id}
                            className={`local-patch-option ${version.id === selectedVersion ? "local-patch-option-selected" : ""}`}
                            onClick={() => setSelectedVersion(version.id)}
                            onDoubleClick={loadSelected}
                          >
                            {new Date(version.savedAt).toLocaleString()}
                          </button>
                        ))}
                    </div>
                  </section>
                </div>
              )}
              {importError ? <p role="alert">{importError}</p> : null}
              <footer className="import-modal-actions">
                <button onClick={() => setLibrary(null)}>Cancel</button>
                <button
                  onClick={loadSelected}
                  disabled={!selectedVersion || loading}
                >
                  Load
                </button>
              </footer>
            </section>
          </div>
        ) : null}
        {subpatches ? (
          <div className="import-modal-backdrop">
            <section
              className="import-modal"
              role="dialog"
              aria-modal="true"
              aria-label="Import subpatch"
            >
              <h2>Import subpatch</h2>
              <div className="import-subpatch-list">
                {subpatches.map((entry, index) => (
                  <button
                    className="import-subpatch-option"
                    key={index}
                    onClick={() => importSubpatch(entry)}
                  >
                    {entry.name}
                    <span>{entry.patch.nodes.length} nodes</span>
                  </button>
                ))}
              </div>
              <footer className="import-modal-actions">
                <button onClick={() => setSubpatches(null)}>Cancel</button>
              </footer>
            </section>
          </div>
        ) : null}
      </main>
    </MidiValuesContext.Provider>
  );
}

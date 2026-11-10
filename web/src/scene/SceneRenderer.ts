import { resolveAsset } from "./assets";
import * as T from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { GraphDocument } from "@pauloricca/spagbol";
import { SceneEvaluator, type SceneEntity } from "./evaluate";
import { loadPaintyAsset } from "./paintyAsset";
import { createPaintyObject, setPaintyLayerVisibility } from "./paintyObject";
import { PaintyMaterial } from "./PaintyMaterial";
function entityConfig(kind: string, data: SceneEntity["node"]["data"]): string {
  if (kind !== "Painty") return JSON.stringify(data);
  // Visibility is live state; toggling it must not reload the file or textures.
  const { paintyLayerVisibility: _visibility, ...resources } = data;
  return JSON.stringify(resources);
}
interface Entity {
  object: T.Object3D;
  kind: string;
  config: string;
  data: SceneEntity["node"]["data"];
  geometry: string;
  texture?: T.Texture;
  video?: HTMLVideoElement;
  disposed: boolean;
  error?: string;
  releaseAsset?: () => void;
  abortLoad?: () => void;
  painty?: { container: T.Group; dimension: number };
}
export class SceneRenderer {
  readonly scene = new T.Scene();
  readonly renderer: T.WebGLRenderer;
  readonly target = new T.WebGLRenderTarget(1, 1, {
    depthBuffer: true,
    type: T.UnsignedByteType,
  });
  readonly entities = new Map<string, Entity>();
  readonly evaluator = new SceneEvaluator();
  readonly fallback = new T.PerspectiveCamera(50, 1, 0.1, 1000);
  private ambient = new T.AmbientLight(0xffffff, 0.65);
  private key = new T.DirectionalLight(0xffffff, 2);
  errors: string[] = [];
  constructor(
    readonly gl: WebGL2RenderingContext,
    canvas: HTMLCanvasElement,
  ) {
    this.renderer = new T.WebGLRenderer({ canvas, context: gl });
    this.renderer.shadowMap.type = T.PCFShadowMap;
    this.renderer.outputColorSpace = T.LinearSRGBColorSpace;
    this.renderer.toneMapping = T.ACESFilmicToneMapping;
    this.fallback.position.z = 5;
    this.key.position.set(3, 4, 5);
    this.scene.add(this.ambient, this.key);
  }
  render(
    document: GraphDocument,
    width: number,
    height: number,
    time: number,
  ): WebGLTexture {
    this.renderer.resetState();
    if (this.target.width !== width || this.target.height !== height)
      this.target.setSize(width, height);
    const evaluated = this.evaluator.evaluate(document, time),
      ids = new Set(evaluated.map((e) => e.id));
    for (const [id, entity] of this.entities)
      if (!ids.has(id)) {
        this.disposeEntity(entity);
        this.entities.delete(id);
      }
    this.scene.background = new T.Color(0.02, 0.02, 0.025);
    this.scene.environment = null;
    this.scene.fog = null;
    this.renderer.toneMappingExposure = 1;
    this.renderer.toneMapping = T.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.ambient.visible = this.key.visible = !evaluated.some(
      (e) => e.visible && e.node.kind.endsWith("Light"),
    );
    let camera: T.Camera = this.fallback;
    const cameras: { id: string; camera: T.Camera }[] = [];
    for (const descriptor of evaluated) {
      const { node, values: v } = descriptor;
      let entity = this.entities.get(descriptor.id);
      const config =
        entity?.data === node.data ? entity.config : entityConfig(node.kind, node.data);
      if (!entity || entity.kind !== node.kind || entity.config !== config) {
        if (entity) this.disposeEntity(entity);
        entity = this.create(descriptor);
        this.entities.set(descriptor.id, entity);
        this.scene.add(entity.object);
      }
      entity.data = node.data;
      const object = entity.object;
      object.visible = descriptor.visible;
      if (!descriptor.visible) {
        entity.video?.pause();
        continue;
      }
      object.position.set(v.positionX ?? 0, v.positionY ?? 0, v.positionZ ?? 0);
      object.rotation.set(v.rotationX ?? 0, v.rotationY ?? 0, v.rotationZ ?? 0);
      object.scale.set(v.scaleX ?? 1, v.scaleY ?? 1, v.scaleZ ?? 1);
      if (entity.painty) {
        entity.painty.container.scale.setScalar(
          Math.max(0.0001, Math.abs(v.size)) / entity.painty.dimension,
        );
        setPaintyLayerVisibility(entity.painty.container.children[0], node.data.paintyLayerVisibility);
      }
      if (object instanceof T.Mesh) {
        const shape = JSON.stringify([
          v.width,
          v.height,
          v.depth,
          v.radius,
          v.topRadius,
          v.bottomRadius,
        ]);
        if (shape !== entity.geometry) {
          const geometry = this.geometry(
            node.kind,
            v,
            node.data.quality === "high" ? 64 : 32,
          );
          if (geometry) {
            object.geometry.dispose();
            object.geometry = geometry;
            entity.geometry = shape;
          }
        }
        if (node.kind === "Text")
          object.scale.multiplyScalar(Math.max(0.001, v.size));
      }
      object.traverse((child) => {
        if (!(child instanceof T.Mesh)) return;
        const paintyDepth = node.kind === "Painty" &&
          child.material instanceof T.MeshBasicMaterial && child.material.userData.paintyDepth === true;
        child.castShadow = child.receiveShadow = node.data.shadows !== false && !paintyDepth;
        if (node.kind === "Mesh" && node.data.overrideMaterial !== true) return;
        for (const mat of Array.isArray(child.material)
          ? child.material
          : [child.material]) {
          if (!(
            mat instanceof T.MeshBasicMaterial ||
            mat instanceof T.MeshStandardMaterial ||
            mat instanceof PaintyMaterial
          ))
            continue;
          mat.color.setRGB(v.colourR ?? 1, v.colourG ?? 1, v.colourB ?? 1);
          mat.opacity = T.MathUtils.clamp(v.opacity ?? 1, 0, 1);
          const transparent = mat.userData.paintyDepth === true ? false :
            mat.opacity < 1 || ["Image", "Video", "Text", "Painty"].includes(node.kind);
          if (mat.transparent !== transparent) {
            mat.transparent = transparent;
            mat.needsUpdate = true;
          }
          if (mat instanceof T.MeshStandardMaterial) {
            mat.roughness = T.MathUtils.clamp(v.roughness ?? 0.5, 0, 1);
            mat.metalness = T.MathUtils.clamp(v.metalness ?? 0, 0, 1);
            mat.emissive.setRGB(
              v.emissiveR ?? 0,
              v.emissiveG ?? 0,
              v.emissiveB ?? 0,
            );
            mat.emissiveIntensity = v.emissiveIntensity ?? 1;
          }
        }
      });
      if (object instanceof T.Light) {
        object.color.setRGB(v.colourR, v.colourG, v.colourB);
        object.intensity = Math.max(0, v.intensity);
      }
      if (object instanceof T.PointLight || object instanceof T.SpotLight)
        object.distance = Math.max(0, v.range);
      if (
        object instanceof T.DirectionalLight ||
        object instanceof T.PointLight ||
        object instanceof T.SpotLight
      ) {
        object.castShadow = node.data.shadows === true;
        object.shadow.intensity = T.MathUtils.clamp(v.shadowStrength, 0, 1);
        object.shadow.radius = T.MathUtils.clamp(v.shadowSoftness, 0, 10);
        object.shadow.bias = T.MathUtils.clamp(v.shadowBias, -0.1, 0.1);
        object.shadow.normalBias = Math.max(0, v.shadowNormalBias);
        const shadowCamera = object.shadow.camera;
        shadowCamera.near = Math.max(0.001, v.shadowNear);
        shadowCamera.far = Math.max(shadowCamera.near + 0.001, v.shadowFar);
        if (shadowCamera instanceof T.OrthographicCamera) {
          const halfSize = Math.max(0.001, v.shadowSize) / 2;
          shadowCamera.left = shadowCamera.bottom = -halfSize;
          shadowCamera.right = shadowCamera.top = halfSize;
        }
        shadowCamera.updateProjectionMatrix();
      }
      if (
        object instanceof T.DirectionalLight ||
        object instanceof T.SpotLight
      ) {
        const direction = new T.Vector3(0, 0, -1).applyEuler(object.rotation);
        if (object instanceof T.DirectionalLight) {
          object.position.copy(direction).multiplyScalar(-10);
          object.target.position.set(0, 0, 0);
        } else {
          object.angle = T.MathUtils.clamp(v.coneAngle, 0.001, Math.PI / 2);
          object.target.position.copy(object.position).add(direction);
        }
        object.target.updateMatrixWorld();
      }
      if (
        object instanceof T.PerspectiveCamera ||
        object instanceof T.OrthographicCamera
      ) {
        object.near = Math.max(0.001, v.near);
        object.far = Math.max(object.near + 0.001, v.far);
        if (object instanceof T.PerspectiveCamera) {
          object.fov = T.MathUtils.clamp(v.fov, 1, 179);
          object.aspect = width / height;
        } else {
          const h = Math.max(0.001, v.size) / 2;
          object.left = (-h * width) / height;
          object.right = -object.left;
          object.top = h;
          object.bottom = -h;
        }
        object.updateProjectionMatrix();
        cameras.push({ id: node.id, camera: object });
      }
      if (entity.video) {
        entity.video.playbackRate = T.MathUtils.clamp(v.speed, 0.0625, 16);
        if (v.playing > 0) {
          if (entity.video.paused)
            void entity.video.play().catch(() => {
              entity!.error = "Video playback requires a click in the page.";
            });
        } else entity.video.pause();
      }
      if (node.kind === "Background") {
        this.scene.background =
          entity.texture ?? new T.Color(v.colourR, v.colourG, v.colourB);
        this.scene.backgroundRotation.y = v.rotation;
      }
      if (node.kind === "Environment Map") {
        this.scene.environment = entity.texture ?? null;
        this.scene.environmentIntensity = v.intensity;
        this.scene.environmentRotation.y = v.rotation;
      }
      if (node.kind === "Fog")
        this.scene.fog =
          node.data.mode === "linear"
            ? new T.Fog(
                new T.Color(v.colourR, v.colourG, v.colourB),
                v.near,
                Math.max(v.near + 0.001, v.far),
              )
            : new T.FogExp2(
                new T.Color(v.colourR, v.colourG, v.colourB),
                Math.max(0, v.density),
              );
      if (node.kind === "Render Settings") {
        this.renderer.toneMappingExposure = Math.max(0, v.exposure);
        this.renderer.shadowMap.enabled = v.shadows > 0;
        this.renderer.toneMapping =
          node.data.toneMapping === "none"
            ? T.NoToneMapping
            : node.data.toneMapping === "reinhard"
              ? T.ReinhardToneMapping
              : T.ACESFilmicToneMapping;
      }
    }
    camera =
      cameras.find((c) => c.id === document.data?.activeCamera)?.camera ??
      cameras[0]?.camera ??
      camera;
    this.fallback.aspect = width / height;
    this.fallback.updateProjectionMatrix();
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(this.scene, camera);
    // Keep access to Three's private GPU handle confined to this version-pinned bridge.
    const texture = (
      this.renderer.properties.get(this.target.texture) as {
        __webglTexture: WebGLTexture;
      }
    ).__webglTexture;
    this.renderer.setRenderTarget(null);
    this.renderer.resetState();
    this.gl.disable(this.gl.DEPTH_TEST);
    this.gl.disable(this.gl.CULL_FACE);
    this.gl.disable(this.gl.BLEND);
    this.gl.disable(this.gl.SCISSOR_TEST);
    this.gl.depthMask(false);
    this.gl.colorMask(true, true, true, true);
    this.errors = [...this.entities.values()].flatMap((e) =>
      e.error ? [e.error] : [],
    );
    return texture;
  }
  geometry(
    kind: string,
    v: Record<string, number>,
    segments: number,
  ): T.BufferGeometry | undefined {
    const positive = (n: number) => Math.max(0.0001, Math.abs(n));
    switch (kind) {
      case "Box":
        return new T.BoxGeometry(
          positive(v.width),
          positive(v.height),
          positive(v.depth),
        );
      case "Sphere":
        return new T.SphereGeometry(positive(v.radius), segments, segments / 2);
      case "Cylinder":
        return new T.CylinderGeometry(
          Math.max(0, v.topRadius),
          Math.max(0, v.bottomRadius),
          positive(v.height),
          segments,
        );
      case "Plane":
      case "Image":
      case "Video":
        return new T.PlaneGeometry(positive(v.width), positive(v.height));
    }
  }
  create({ node, values }: SceneEntity): Entity {
    const kind = node.kind,
      data = node.data;
    let object: T.Object3D = new T.Object3D();
    if (
      ["Plane", "Box", "Sphere", "Cylinder", "Image", "Video", "Text"].includes(
        kind,
      )
    ) {
      const Material =
        ["Image", "Video", "Text"].includes(kind) || data.material === "basic"
          ? T.MeshBasicMaterial
          : data.material === "physical"
            ? T.MeshPhysicalMaterial
            : T.MeshStandardMaterial;
      object = new T.Mesh(
        this.geometry(kind, values, 32) ?? new T.PlaneGeometry(2, 1),
        new Material({ side: T.DoubleSide }),
      );
    }
    if (kind === "Mesh" || kind === "Painty") object = new T.Group();
    if (kind === "Perspective Camera") object = new T.PerspectiveCamera();
    if (kind === "Orthographic Camera") object = new T.OrthographicCamera();
    if (kind === "Ambient Light") object = new T.AmbientLight();
    if (kind === "Directional Light") object = new T.DirectionalLight();
    if (kind === "Point Light") object = new T.PointLight();
    if (kind === "Spot Light") object = new T.SpotLight();
    if (
      object instanceof T.DirectionalLight ||
      object instanceof T.PointLight ||
      object instanceof T.SpotLight
    ) {
      // Resolution is static configuration: changing it recreates the entity
      // and disposes the old GPU shadow map rather than reallocating per frame.
      const requested = Number(data.shadowResolution ?? 1024);
      const resolution = [256, 512, 1024, 2048].includes(requested) ? requested : 1024;
      object.shadow.mapSize.set(resolution, resolution);
    }
    const entity: Entity = {
      object,
      kind,
      config: entityConfig(kind, data),
      data,
      geometry: "",
      disposed: false,
    };
    const attach = (texture: T.Texture) => {
      if (entity.disposed) {
        texture.dispose();
        return;
      }
      texture.colorSpace = T.SRGBColorSpace;
      texture.magFilter =
        data.filtering === "nearest" ? T.NearestFilter : T.LinearFilter;
      entity.texture = texture;
      if (object instanceof T.Mesh) {
        (object.material as T.MeshBasicMaterial).map = texture;
        (object.material as T.Material).needsUpdate = true;
      }
      if (
        kind === "Environment Map" ||
        (kind === "Background" && data.mapping === "equirectangular")
      )
        texture.mapping = T.EquirectangularReflectionMapping;
    };
    if (kind === "Painty" && data.url) {
      const controller = new AbortController();
      entity.abortLoad = () => controller.abort();
      void loadPaintyAsset(String(data.url), controller.signal)
        .then((document) => {
          if (entity.disposed) return;
          const container = new T.Group();
          const layers = createPaintyObject(document);
          setPaintyLayerVisibility(layers, entity.data.paintyLayerVisibility);
          container.add(layers);
          entity.painty = { container, dimension: Math.max(document.width, document.height) };
          container.scale.setScalar(Math.max(0.0001, Math.abs(values.size)) / entity.painty.dimension);
          object.add(container);
        })
        .catch((error) => {
          if (!entity.disposed) entity.error = String(error);
        });
    } else if (kind === "Text") {
      const canvas = document.createElement("canvas");
      canvas.width = 2048;
      canvas.height = 512;
      const ctx = canvas.getContext("2d")!;
      ctx.font = `160px ${String(data.font ?? "sans-serif")}`;
      ctx.fillStyle = "white";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(data.text ?? "Visual Visual"), 1024, 256, 2000);
      attach(new T.CanvasTexture(canvas));
    } else if (data.url) {
      void resolveAsset(String(data.url))
        .then((asset) => {
          if (entity.disposed) {
            asset.release();
            return;
          }
          entity.releaseAsset = asset.release;
          const url = asset.url;
          if (kind === "Video") {
            const video = document.createElement("video");
            video.crossOrigin = "anonymous";
            video.src = url;
            video.loop = data.loop !== false;
            video.muted = true;
            video.playsInline = true;
            video.onerror = () => {
              entity.error = `Could not load video: ${data.url}`;
            };
            entity.video = video;
            attach(new T.VideoTexture(video));
          } else if (kind === "Mesh") {
            new GLTFLoader().load(
              url,
              (gltf) => {
                if (entity.disposed) {
                  this.disposeObject(gltf.scene);
                  return;
                }
                if (data.overrideMaterial === true)
                  gltf.scene.traverse((child) => {
                    if (child instanceof T.Mesh) {
                      for (const mat of Array.isArray(child.material)
                        ? child.material
                        : [child.material])
                        mat.dispose();
                      child.material = new T.MeshStandardMaterial();
                    }
                  });
                object.add(gltf.scene);
              },
              undefined,
              () => {
                entity.error = `Could not load model: ${data.url}`;
              },
            );
          } else
            new T.TextureLoader().load(url, attach, undefined, () => {
              entity.error = `Could not load image: ${data.url}`;
            });
        })
        .catch((error) => {
          if (!entity.disposed) entity.error = String(error);
        });
    }
    return entity;
  }
  disposeObject(object: T.Object3D) {
    const textures = new Set<T.Texture>();
    object.traverse((child) => {
      if (child instanceof T.DirectionalLight || child instanceof T.PointLight || child instanceof T.SpotLight) child.shadow.dispose();
      if (child instanceof T.Mesh) {
        child.geometry.dispose();
        for (const mat of Array.isArray(child.material)
          ? child.material
          : [child.material]) {
          for (const value of Object.values(mat))
            if (value instanceof T.Texture) textures.add(value);
          mat.dispose();
        }
      }
    });
    for (const texture of textures) texture.dispose();
  }
  disposeEntity(entity: Entity) {
    entity.disposed = true;
    entity.abortLoad?.();
    this.scene.remove(entity.object);
    this.disposeObject(entity.object);
    entity.texture?.dispose();
    if (entity.video) {
      entity.video.pause();
      entity.video.removeAttribute("src");
      entity.video.load();
    }
    entity.releaseAsset?.();
  }
  dispose() {
    for (const entity of this.entities.values()) this.disposeEntity(entity);
    this.entities.clear();
    this.target.dispose();
    this.renderer.dispose();
  }
}

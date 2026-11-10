import * as T from "three";
import { PaintyMaterial } from "./PaintyMaterial";
import { paintyLayerVisible, type PaintyDocument, type PaintyRotation } from "./painty";

export function setPaintyLayerVisibility(document: T.Object3D, overrides: unknown) {
  for (const layer of document.children)
    layer.visible = paintyLayerVisible({
      id: layer.userData.paintyLayerId,
      visible: layer.userData.paintyVisible,
    }, overrides);
}

function rotation(target: T.Object3D, value: PaintyRotation) {
  // Reflect Painty's downward Y into Three's upward Y. Painty applies X, Y, Z
  // sequentially; Three's extrinsic equivalent is Euler order ZYX.
  const rad = Math.PI / 180;
  target.rotation.set(-value.x * rad, value.y * rad, -value.z * rad, "ZYX");
}

/** A pixel-space hierarchy. The containing scene entity supplies scene transforms. */
export function createPaintyObject(document: PaintyDocument): T.Group {
  const group = new T.Group();
  group.name = "Painty document";
  group.userData.painty = {
    width: document.width,
    height: document.height,
    perspective: document.perspective,
  };
  group.position.set(document.position.x, -document.position.y, document.position.z);
  rotation(group, document.rotation);
  for (const layer of document.layers) {
    const texture = new T.DataTexture(layer.pixels, document.width, document.height, T.RGBAFormat);
    texture.flipY = true;
    texture.magFilter = texture.minFilter = T.NearestFilter;
    texture.generateMipmaps = false;
    // Painty composites the stored channel values directly, without sRGB decoding.
    texture.colorSpace = T.LinearSRGBColorSpace;
    texture.needsUpdate = true;
    const mesh = new T.Mesh(
      new T.PlaneGeometry(document.width, document.height),
      new PaintyMaterial(texture),
    );
    mesh.name = layer.name;
    mesh.userData.paintyLayerId = layer.id;
    mesh.userData.paintyVisible = layer.visible;
    mesh.visible = layer.visible;
    mesh.position.set(layer.position.x, -layer.position.y, layer.depth);
    rotation(mesh, layer.rotation);
    // Opaque pixels participate in the scene depth buffer before transparent
    // color passes. This also gives intersecting opaque layers correct occlusion.
    const depth = new T.Mesh(
      mesh.geometry.clone(),
      new T.MeshBasicMaterial({
        map: texture,
        side: T.DoubleSide,
        alphaTest: 1,
        colorWrite: false,
        depthWrite: true,
        toneMapped: false,
      }),
    );
    depth.material.userData.paintyDepth = true;
    mesh.add(depth);
    group.add(mesh);
  }
  return group;
}

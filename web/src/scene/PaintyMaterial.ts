import * as T from "three";

// A painted surface keeps its stored colors and only takes shadow attenuation
// from scene lights. ShadowMaterial supplies Three's light/shadow uniforms and
// updates opacity; the basic shader supplies RGBA texture sampling and cutouts.
export class PaintyMaterial extends T.ShadowMaterial {
  readonly map: T.Texture;

  constructor(map: T.Texture) {
    super({
      color: 0xffffff,
      side: T.DoubleSide,
      alphaTest: 0.5 / 255,
      depthWrite: false,
      toneMapped: false,
    });
    this.map = map;
  }

  override onBeforeCompile(shader: T.WebGLProgramParametersWithUniforms) {
    Object.assign(shader.uniforms, T.UniformsUtils.clone(T.ShaderLib.basic.uniforms), {
      map: { value: this.map },
      diffuse: { value: this.color },
      alphaTest: { value: this.alphaTest },
    });
    shader.vertexShader = T.ShaderLib.basic.vertexShader
      .replace("#include <common>", "#include <common>\n#include <shadowmap_pars_vertex>")
      .replace("#if defined ( USE_ENVMAP ) || defined ( USE_SKINNING )", "#if 1")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\n#include <shadowmap_vertex>");
    shader.fragmentShader = T.ShaderLib.basic.fragmentShader
      .replace("#include <common>", `#include <common>
#include <bsdfs>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>`)
      .replace("vec3 outgoingLight = reflectedLight.indirectDiffuse;",
        "vec3 outgoingLight = reflectedLight.indirectDiffuse * getShadowMask();");
  }

  override customProgramCacheKey() {
    return "painty-shadow-v1";
  }
}

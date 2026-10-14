import { Color, DoubleSide, MeshMatcapMaterial, Vector2, type Texture } from 'three';

export interface SurfaceUniforms {
  uBackColor: { value: Color };
  /** 1 = back faces drawn in uBackColor, 0 = back faces shaded like front faces. */
  uBackMix: { value: number };
  /** Colour-map LUT (256×1) and the scalar range mapped onto it. */
  uLut: { value: Texture | null };
  uRange: { value: Vector2 };
  /** 0 = full colour, 1 = grey (the dimmed surroundings of the focus view). */
  uDesaturate: { value: number };
}

export interface SurfaceMaterial extends MeshMatcapMaterial {
  userData: { uniforms: SurfaceUniforms };
}

/**
 * Matcap material with a distinct back-face color (via gl_FrontFacing), so
 * holes and the inside of open scans are obvious.
 *
 * Optional colour map: with `defines.USE_SCALAR_MAP`, a vec2 `scalar`
 * attribute (value, hasValue) is mapped through `uLut` over `uRange` and
 * shaded by the matcap's luminance, so the surface keeps its 3D shape.
 *
 * Polygon offset pushes surfaces slightly back in depth, so overlay lines
 * drawn exactly on the surface (margin, live-wire path) win the depth test.
 */
export function createSurfaceMaterial(matcap: Texture, backColor = new Color('#b0496b')): SurfaceMaterial {
  const uniforms: SurfaceUniforms = {
    uBackColor: { value: backColor },
    uBackMix: { value: 1 },
    uLut: { value: null },
    uRange: { value: new Vector2(0, 1) },
    uDesaturate: { value: 0 },
  };
  const material = new MeshMatcapMaterial({
    matcap,
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  }) as SurfaceMaterial;
  material.userData.uniforms = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        ['#include <common>', '#ifdef USE_SCALAR_MAP', 'attribute vec2 scalar;', 'varying vec2 vScalar;', '#endif'].join('\n'),
      )
      .replace('#include <begin_vertex>', ['#include <begin_vertex>', '#ifdef USE_SCALAR_MAP', 'vScalar = scalar;', '#endif'].join('\n'));
    shader.fragmentShader = shader.fragmentShader
      .replace(
        'uniform sampler2D matcap;',
        [
          'uniform sampler2D matcap;',
          'uniform vec3 uBackColor;',
          'uniform float uBackMix;',
          'uniform float uDesaturate;',
          '#ifdef USE_SCALAR_MAP',
          'uniform sampler2D uLut;',
          'uniform vec2 uRange;',
          'varying vec2 vScalar;',
          '#endif',
        ].join('\n'),
      )
      .replace(
        '#include <opaque_fragment>',
        [
          '#include <opaque_fragment>',
          '#ifdef USE_SCALAR_MAP',
          'if ( vScalar.y > 0.5 ) {',
          '  float t = clamp( ( vScalar.x - uRange.x ) / max( uRange.y - uRange.x, 1e-6 ), 0.0, 1.0 );',
          '  vec3 lut = texture2D( uLut, vec2( t, 0.5 ) ).rgb;',
          '  float lum = dot( matcapColor.rgb, vec3( 0.333 ) );',
          '  gl_FragColor.rgb = lut * ( 0.35 + 0.9 * lum );',
          '}',
          '#endif',
          'if ( !gl_FrontFacing ) {',
          '  float shade = 0.55 + 0.45 * dot( matcapColor.rgb, vec3( 0.333 ) );',
          '  gl_FragColor.rgb = mix( gl_FragColor.rgb, uBackColor * shade, uBackMix );',
          '}',
          'gl_FragColor.rgb = mix( gl_FragColor.rgb, vec3( dot( gl_FragColor.rgb, vec3( 0.299, 0.587, 0.114 ) ) ), uDesaturate );',
        ].join('\n'),
      );
  };
  material.customProgramCacheKey = () => `dcad-surface-v3${material.defines?.USE_SCALAR_MAP ? '-scalar' : ''}`;
  return material;
}

/** Turn the colour map on or off (recompiles the program on change). */
export function setScalarMap(material: SurfaceMaterial, lut: Texture | null, range: [number, number] = [0, 1]): void {
  const enabled = Boolean(lut);
  const was = Boolean(material.defines?.USE_SCALAR_MAP);
  material.userData.uniforms.uLut.value = lut;
  material.userData.uniforms.uRange.value.set(range[0], range[1]);
  if (enabled !== was) {
    material.defines = { ...(material.defines ?? {}) };
    if (enabled) material.defines.USE_SCALAR_MAP = '';
    else delete material.defines.USE_SCALAR_MAP;
    material.needsUpdate = true;
  }
}

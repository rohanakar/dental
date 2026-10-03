import { Color, DoubleSide, MeshMatcapMaterial, type Texture } from 'three';

export interface SurfaceUniforms {
  uBackColor: { value: Color };
  /** 1 = back faces drawn in uBackColor, 0 = back faces shaded like front faces. */
  uBackMix: { value: number };
}

export interface SurfaceMaterial extends MeshMatcapMaterial {
  userData: { uniforms: SurfaceUniforms };
}

/**
 * Matcap material with a distinct back-face color (via gl_FrontFacing), so
 * holes and the inside of open scans are obvious.
 */
export function createSurfaceMaterial(matcap: Texture, backColor = new Color('#b0496b')): SurfaceMaterial {
  const uniforms: SurfaceUniforms = {
    uBackColor: { value: backColor },
    uBackMix: { value: 1 },
  };
  const material = new MeshMatcapMaterial({ matcap, side: DoubleSide }) as SurfaceMaterial;
  material.userData.uniforms = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('uniform sampler2D matcap;', 'uniform sampler2D matcap;\nuniform vec3 uBackColor;\nuniform float uBackMix;')
      .replace(
        '#include <opaque_fragment>',
        [
          '#include <opaque_fragment>',
          'if ( !gl_FrontFacing ) {',
          '  float shade = 0.55 + 0.45 * dot( matcapColor.rgb, vec3( 0.333 ) );',
          '  gl_FragColor.rgb = mix( gl_FragColor.rgb, uBackColor * shade, uBackMix );',
          '}',
        ].join('\n'),
      );
  };
  material.customProgramCacheKey = () => 'dcad-surface-v1';
  return material;
}

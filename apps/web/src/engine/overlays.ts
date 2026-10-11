import {
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Points,
  Quaternion,
  ShaderMaterial,
  Vector3,
  type Object3D,
  type Scene,
} from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

export type V3 = readonly [number, number, number];
/** Flat xyz array or a list of points. */
export type PointList = Float32Array | ReadonlyArray<V3>;

export interface PolylineOptions {
  color: string;
  /** Screen-space width in CSS pixels. */
  widthPx?: number;
  closed?: boolean;
  /** false = always drawn on top (e.g. the live preview). */
  depthTest?: boolean;
  dashed?: boolean;
  opacity?: number;
}

export interface MarkerOptions {
  color: string;
  outline?: string;
  /** Diameter in CSS pixels. */
  sizePx?: number;
  depthTest?: boolean;
}

export interface ArrowOptions {
  color: string;
  /** Shaft radius in mm. */
  radiusMm?: number;
  depthTest?: boolean;
}

function toFlat(points: PointList, closed: boolean): number[] {
  const out: number[] = [];
  if (points instanceof Float32Array) {
    for (let i = 0; i < points.length; i++) out.push(points[i]!);
    if (closed && points.length >= 3) out.push(points[0]!, points[1]!, points[2]!);
  } else {
    for (const p of points) out.push(p[0], p[1], p[2]);
    if (closed && points.length > 0) out.push(...points[0]!);
  }
  return out;
}

const MARKER_VERTEX = /* glsl */ `
uniform float uSize;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  gl_PointSize = uSize;
}`;

const MARKER_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uOutline;
void main() {
  float r = length( gl_PointCoord - 0.5 );
  if ( r > 0.5 ) discard;
  float edge = smoothstep( 0.30, 0.36, r );
  gl_FragColor = vec4( mix( uColor, uOutline, edge ), 1.0 );
  #include <colorspace_fragment>
}`;

/**
 * Overlay primitives drawn over the scans: polylines (margin, live-wire
 * preview), screen-space point markers (anchors, contacts) and arrows
 * (tooth frame, insertion axis). Everything is keyed by id; setting an id
 * again replaces it.
 */
export class OverlayLayer {
  readonly root = new Group();
  private readonly items = new Map<string, Object3D>();
  private readonly lineMaterials = new Set<LineMaterial>();
  private width = 1;
  private height = 1;
  private pixelRatio = 1;

  constructor(
    scene: Scene,
    private readonly requestRender: () => void,
  ) {
    this.root.name = 'overlays';
    this.root.renderOrder = 10;
    scene.add(this.root);
  }

  setResolution(width: number, height: number, pixelRatio: number): void {
    this.width = width;
    this.height = height;
    this.pixelRatio = pixelRatio;
    for (const m of this.lineMaterials) m.resolution.set(width * pixelRatio, height * pixelRatio);
    for (const obj of this.items.values()) {
      if (obj instanceof Points) (obj.material as ShaderMaterial).uniforms.uSize!.value = (obj.userData.sizePx as number) * pixelRatio;
    }
  }

  setPolyline(id: string, points: PointList, opts: PolylineOptions): void {
    const flat = toFlat(points, Boolean(opts.closed));
    if (flat.length < 6) {
      this.remove(id);
      return;
    }
    const geometry = new LineGeometry();
    geometry.setPositions(flat);
    const material = new LineMaterial({
      color: new Color(opts.color).getHex(),
      linewidth: (opts.widthPx ?? 3) * this.pixelRatio,
      worldUnits: false,
      dashed: Boolean(opts.dashed),
      dashSize: 0.4,
      gapSize: 0.25,
      depthTest: opts.depthTest ?? true,
      transparent: (opts.opacity ?? 1) < 1,
      opacity: opts.opacity ?? 1,
    });
    material.resolution.set(this.width * this.pixelRatio, this.height * this.pixelRatio);
    const line = new Line2(geometry, material);
    if (opts.dashed) line.computeLineDistances();
    line.renderOrder = opts.depthTest === false ? 20 : 10;
    this.put(id, line);
    this.lineMaterials.add(material);
  }

  setMarkers(id: string, points: PointList, opts: MarkerOptions): void {
    const flat = toFlat(points, false);
    if (flat.length === 0) {
      this.remove(id);
      return;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(flat), 3));
    const sizePx = opts.sizePx ?? 10;
    const material = new ShaderMaterial({
      uniforms: {
        uSize: { value: sizePx * this.pixelRatio },
        uColor: { value: new Color(opts.color) },
        uOutline: { value: new Color(opts.outline ?? '#ffffff') },
      },
      vertexShader: MARKER_VERTEX,
      fragmentShader: MARKER_FRAGMENT,
      depthTest: opts.depthTest ?? false,
      depthWrite: false,
    });
    const points3 = new Points(geometry, material);
    points3.userData.sizePx = sizePx;
    points3.renderOrder = 30;
    points3.frustumCulled = false;
    this.put(id, points3);
  }

  setArrow(id: string, origin: V3, direction: V3, lengthMm: number, opts: ArrowOptions): void {
    const dir = new Vector3(...direction).normalize();
    const radius = opts.radiusMm ?? 0.12;
    const headLength = Math.min(lengthMm * 0.3, radius * 8);
    const material = new MeshBasicMaterial({
      color: new Color(opts.color),
      depthTest: opts.depthTest ?? false,
      depthWrite: false,
      transparent: true,
      opacity: 0.95,
    });
    const shaft = new Mesh(new CylinderGeometry(radius, radius, lengthMm - headLength, 12), material);
    shaft.position.y = (lengthMm - headLength) / 2;
    const head = new Mesh(new ConeGeometry(radius * 2.6, headLength, 16), material);
    head.position.y = lengthMm - headLength / 2;
    const arrow = new Group();
    arrow.add(shaft, head);
    arrow.position.set(...origin);
    arrow.quaternion.copy(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir));
    arrow.renderOrder = 25;
    shaft.renderOrder = head.renderOrder = 25;
    this.put(id, arrow);
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  remove(id: string): void {
    const obj = this.items.get(id);
    if (!obj) return;
    this.root.remove(obj);
    this.items.delete(id);
    obj.traverse((o) => {
      const mesh = o as Partial<Mesh>;
      mesh.geometry?.dispose();
      const material = mesh.material;
      if (material && !Array.isArray(material)) {
        if (material instanceof LineMaterial) this.lineMaterials.delete(material);
        material.dispose();
      }
    });
    this.requestRender();
  }

  /** Remove every overlay whose id starts with `prefix`. */
  removePrefix(prefix: string): void {
    for (const id of [...this.items.keys()]) if (id.startsWith(prefix)) this.remove(id);
  }

  clear(): void {
    this.removePrefix('');
  }

  private put(id: string, obj: Object3D): void {
    this.remove(id);
    obj.name = id;
    this.items.set(id, obj);
    this.root.add(obj);
    this.requestRender();
  }
}

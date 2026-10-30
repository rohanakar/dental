import CameraControls from 'camera-controls';
import {
  Box3,
  BufferAttribute,
  Color,
  DoubleSide,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MOUSE,
  OrthographicCamera,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  Scene,
  Sphere,
  Spherical,
  SRGBColorSpace,
  Vector2,
  Vector3,
  Vector4,
  BufferGeometry,
  WebGLRenderer,
  type Intersection,
} from 'three';
import { acceleratedRaycast } from 'three-mesh-bvh';
import { COLOR_MAPS, createLutTexture, packScalars, type ColorMapName, type ColorStops } from './colormap';
import { createMatcap, MATCAP_PRESETS, type MatcapPreset } from './matcap';
import { createSurfaceMaterial, setScalarMap, type SurfaceMaterial } from './materials';
import { TranslateGizmo, type GizmoOptions } from './gizmo';
import { OverlayLayer } from './overlays';
import { viewDirection, WORLD_VIEW_FRAME, type StandardView, type ViewFrame } from './viewFrame';

CameraControls.install({
  THREE: { Vector2, Vector3, Vector4, Quaternion, Matrix4, Spherical, Box3, Sphere, Raycaster },
});

export type ObjectKind = 'jaw' | 'restoration';
export type Projection = 'perspective' | 'orthographic';

export interface ViewerHit {
  objectId: string;
  point: Vector3;
  /** Face index in the BVH-ordered index buffer. Not stable across imports. */
  faceIndex: number;
  normal: Vector3 | null;
  distance: number;
}

/**
 * Focus look for a scan (see Viewer.setObjectFocus): `faces` keep the
 * object's normal look, everything else is drawn at `contextOpacity` × the
 * object's opacity and greyed by `desaturate`.
 */
export interface FocusLook {
  /** Face ids (BVH order) shown in focus; null = the whole object is surroundings. */
  faces: Uint32Array | null;
  contextOpacity: number;
  desaturate: number;
}

interface ViewerObject {
  mesh: Mesh<BufferGeometry, SurfaceMaterial>;
  kind: ObjectKind;
  /** The object's own opacity (object panel, crown slider). */
  opacity: number;
  focus: (FocusLook & { overlay: Mesh<BufferGeometry, SurfaceMaterial> | null }) | null;
  /** Depth-only copy drawn just before a see-through object (see syncPrepass). */
  prepass: Mesh<BufferGeometry, MeshBasicMaterial> | null;
}

/** First draw order of see-through objects (orderSeeThrough gives each its pre-pass and colour pass in turn). */
const SEE_THROUGH_ORDER = 1;

/** Shallow copy of some faces of an indexed geometry, with compacted vertices (position, normal, colour). */
function subsetGeometry(source: BufferGeometry, faces: Uint32Array): BufferGeometry {
  const index = source.index!.array;
  const remap = new Map<number, number>();
  const tri = new Uint32Array(faces.length * 3);
  const used: number[] = [];
  for (let i = 0; i < faces.length; i++) {
    for (let k = 0; k < 3; k++) {
      const v = index[faces[i]! * 3 + k]!;
      let j = remap.get(v);
      if (j === undefined) {
        j = used.length;
        remap.set(v, j);
        used.push(v);
      }
      tri[i * 3 + k] = j;
    }
  }
  const g = new BufferGeometry();
  for (const name of ['position', 'normal', 'color']) {
    const attr = source.getAttribute(name) as BufferAttribute | undefined;
    if (!attr) continue;
    const { itemSize } = attr;
    const src = attr.array as Float32Array | Uint8Array;
    const out = new (src.constructor as Float32ArrayConstructor | Uint8ArrayConstructor)(used.length * itemSize);
    used.forEach((v, j) => out.set(src.subarray(v * itemSize, v * itemSize + itemSize), j * itemSize));
    g.setAttribute(name, new BufferAttribute(out, itemSize, attr.normalized));
  }
  g.setIndex(new BufferAttribute(tri, 1));
  g.computeBoundingSphere();
  return g;
}

/** Polygon offset of a scan's dimmed surroundings in the focus view (the surface default is 1). */
const SURROUNDINGS_POLYGON_OFFSET = 2;
/**
 * The dimmed surroundings blend as if over a ground at least this light (sRGB luma), so on the dark theme's ground
 * they read as pale tooth and gum, not dark grey and maroon. The light ground is above it: no change there.
 */
const SURROUNDINGS_GROUND_FLOOR = 0.34;

/** Opacity < 1 renders transparent (no depth writes, back faces untinted so the far side reads as surface). */
function setMaterialOpacity(m: SurfaceMaterial, opacity: number): void {
  const transparent = opacity < 0.999;
  if (m.transparent !== transparent) {
    m.transparent = transparent;
    m.depthWrite = !transparent;
    m.needsUpdate = true;
  }
  m.opacity = opacity;
  m.userData.uniforms.uBackMix.value = transparent ? 0 : 1;
}

/**
 * Tool input on the viewport. Hits are raycast against `targets()` (default:
 * every visible object). A click is a left press and release that moved less
 * than CLICK_SLOP_PX; any larger movement orbits the camera as usual.
 */
export interface InteractionHandler {
  targets?: () => string[];
  cursor?: string;
  onClick?(hit: ViewerHit | null, event: PointerEvent): void;
  /** Pointer moved with no button pressed (throttled to one call per frame). */
  onHover?(hit: ViewerHit | null, event: PointerEvent): void;
  /** Return true to take over this left-drag; the camera then stays still. */
  onDragStart?(event: PointerEvent): boolean;
  onDrag?(hit: ViewerHit | null, event: PointerEvent): void;
  onDragEnd?(event: PointerEvent): void;
}

const CLICK_SLOP_PX = 5;
const CLICK_MAX_MS = 700;

export interface ViewerOptions {
  /** Device pixel ratio cap (default 2). */
  maxPixelRatio?: number;
  background?: string;
}

const MAX_PIXEL_RATIO = 2;
const FOV = 35;

/**
 * Imperative three.js viewer. React talks to it through this small API;
 * it never imports React. Renders on demand: a frame is drawn only when the
 * camera moves or something in the scene changed.
 */
export class Viewer {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  private readonly perspective: PerspectiveCamera;
  private readonly orthographic: OrthographicCamera;
  private readonly controls: CameraControls;
  private readonly objects = new Map<string, ViewerObject>();
  private readonly matcaps = new Map<MatcapPreset, ReturnType<typeof createMatcap>>();
  private readonly raycaster = new Raycaster();
  readonly overlays: OverlayLayer;
  /** Colour-map lookup textures, by map name or by the stops' JSON. */
  private readonly luts = new Map<string, ReturnType<typeof createLutTexture>>();
  private interaction: InteractionHandler | null = null;
  private pointerDown: { x: number; y: number; t: number } | null = null;
  private dragging = false;
  private hoverEvent: PointerEvent | null = null;
  private gizmo: TranslateGizmo | null = null;
  /** A left press started on a gizmo handle: no orbit point, no tool click. */
  private gizmoPress = false;
  private readonly resizeObserver: ResizeObserver;
  private frame: ViewFrame = WORLD_VIEW_FRAME;
  private projection: Projection = 'perspective';
  /** Visible height (mm) of the orthographic frustum at zoom 1. */
  private orthoHeight = 100;
  /** How far the ground is below SURROUNDINGS_GROUND_FLOOR (0 on a light ground). */
  private groundLift = 0;
  private needsRender = true;
  private rafId = 0;
  private lastTime = performance.now();
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    options: ViewerOptions = {},
  ) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, options.maxPixelRatio ?? MAX_PIXEL_RATIO));
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);
    this.setBackground(options.background ?? '#20242a');

    const { width, height } = this.size();
    this.perspective = new PerspectiveCamera(FOV, width / height, 0.1, 5000);
    this.orthographic = new OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
    for (const camera of [this.perspective, this.orthographic]) camera.up.set(...this.frame.up);
    this.perspective.position.set(0, -120, 60);

    this.controls = new CameraControls(this.perspective, this.renderer.domElement);
    this.controls.dollyToCursor = true;
    this.controls.infinityDolly = true;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 1500;
    this.controls.smoothTime = 0.12;
    this.controls.draggingSmoothTime = 0.04;
    this.controls.mouseButtons.right = CameraControls.ACTION.TRUCK;
    this.controls.addEventListener('update', () => this.requestRender());
    this.overlays = new OverlayLayer(this.scene, () => this.requestRender());

    // Cursor-centric orbit: before camera-controls sees the pointerdown
    // (capture phase on the container), orbit around the surface point under
    // the cursor.
    container.addEventListener('pointerdown', this.onPointerDown, { capture: true });
    container.addEventListener('pointermove', this.onPointerMove);
    container.addEventListener('pointerleave', this.onPointerLeave);
    window.addEventListener('pointerup', this.onPointerUp);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.loop();
  }

  // ---- objects -------------------------------------------------------------

  addObject(id: string, geometry: BufferGeometry, opts: { kind?: ObjectKind; vertexColors?: boolean } = {}): void {
    this.removeObject(id);
    const kind = opts.kind ?? 'jaw';
    const material = createSurfaceMaterial(this.matcap(kind === 'jaw' ? 'stone' : 'restoration'));
    const mesh = new Mesh(geometry, material);
    mesh.name = id;
    mesh.raycast = acceleratedRaycast;
    this.objects.set(id, { mesh, kind, opacity: 1, focus: null, prepass: null });
    this.scene.add(mesh);
    this.setObjectVertexColors(id, Boolean(opts.vertexColors));
    this.requestRender();
  }

  /** Removes the object. The geometry is owned by the caller and is not disposed. */
  removeObject(id: string): void {
    const obj = this.objects.get(id);
    if (!obj) return;
    this.disposeOverlay(obj);
    this.disposePrepass(obj);
    this.scene.remove(obj.mesh);
    obj.mesh.material.dispose();
    this.objects.delete(id);
    this.requestRender();
  }

  hasObject(id: string): boolean {
    return this.objects.has(id);
  }

  setObjectVisible(id: string, visible: boolean): void {
    const obj = this.objects.get(id);
    if (!obj || obj.mesh.visible === visible) return;
    obj.mesh.visible = visible;
    this.requestRender();
  }

  /**
   * Opacity < 1 renders the object transparent. Transparent objects draw
   * after opaque ones; three.js draws transparent double-sided materials in
   * two passes (back faces, then front faces). Back-face tint is disabled
   * while transparent so the far side reads as surface, not as a hole.
   */
  setObjectOpacity(id: string, opacity: number): void {
    const obj = this.objects.get(id);
    if (!obj) return;
    obj.opacity = opacity;
    this.applyLook(obj);
  }

  /**
   * Focus view for a scan, or null for its normal look. The focus faces are
   * a small opaque copy with the usual surface material; the object itself
   * becomes the dimmed, greyed surroundings and is pushed back in depth
   * (polygon offset), so its own copy of the focus faces loses the depth
   * test while the copy meets the crown exactly as the scan did. Picking
   * still hits the object (the copy is not a raycast target).
   */
  setObjectFocus(id: string, look: FocusLook | null): void {
    const obj = this.objects.get(id);
    if (!obj) return;
    if (!look) {
      this.disposeOverlay(obj);
      obj.focus = null;
    } else {
      let overlay = obj.focus?.faces === look.faces ? obj.focus.overlay : null;
      if (!overlay) {
        this.disposeOverlay(obj);
        if (look.faces && look.faces.length > 0) {
          overlay = new Mesh(subsetGeometry(obj.mesh.geometry, look.faces), createSurfaceMaterial(obj.mesh.material.matcap!));
          overlay.name = `${id}:focus`;
          overlay.raycast = () => undefined;
          obj.mesh.add(overlay);
        }
      }
      obj.focus = { ...look, overlay };
    }
    this.applyLook(obj);
  }

  setObjectVertexColors(id: string, enabled: boolean): void {
    const obj = this.objects.get(id);
    if (!obj) return;
    const m = obj.mesh.material;
    const useColors = enabled && Boolean(obj.mesh.geometry.getAttribute('color'));
    m.vertexColors = useColors;
    m.matcap = this.matcap(useColors ? 'neutral' : obj.kind === 'jaw' ? 'stone' : 'restoration');
    m.needsUpdate = true;
    this.applyLook(obj);
  }

  /**
   * Colour-map overlay from per-vertex scalars (NaN = no value), or null to
   * turn it off. Writes a `scalar` attribute onto the object's geometry.
   */
  setObjectScalars(
    id: string,
    values: Float32Array | null,
    opts: { map: ColorMapName; range: [number, number]; stops?: ColorStops } = { map: 'sequential', range: [0, 1] },
  ): void {
    const obj = this.objects.get(id);
    if (!obj) return;
    const geometry = obj.mesh.geometry;
    if (!values) {
      geometry.deleteAttribute('scalar');
      setScalarMap(obj.mesh.material, null);
    } else {
      geometry.setAttribute('scalar', new BufferAttribute(packScalars(values), 2));
      setScalarMap(obj.mesh.material, this.lut(opts.stops ?? opts.map), opts.range);
    }
    this.requestRender();
  }

  // ---- camera --------------------------------------------------------------

  getViewFrame(): ViewFrame {
    return this.frame;
  }

  setViewFrame(frame: ViewFrame): void {
    this.frame = frame;
    for (const camera of [this.perspective, this.orthographic]) camera.up.set(...frame.up);
    this.controls.updateCameraUp();
    this.requestRender();
  }

  getProjection(): Projection {
    return this.projection;
  }

  setProjection(projection: Projection): void {
    if (projection === this.projection) return;
    const target = this.controls.getTarget(new Vector3());
    const position = this.controls.getPosition(new Vector3());
    const dir = position.clone().sub(target);
    const distance = dir.length();
    dir.normalize();
    const halfFov = (this.perspective.fov * Math.PI) / 360;

    if (projection === 'orthographic') {
      // Match the visible height at the target distance, then move the camera
      // back so near-plane clipping never cuts the model.
      const visibleHeight = 2 * distance * Math.tan(halfFov);
      this.orthographic.zoom = 1;
      this.orthoHeight = visibleHeight;
      this.updateOrthoFrustum();
      this.controls.camera = this.orthographic;
      this.controls.mouseButtons.wheel = CameraControls.ACTION.ZOOM;
      this.controls.mouseButtons.middle = CameraControls.ACTION.ZOOM;
      const far = Math.max(distance, 400);
      void this.controls.setLookAt(...target.clone().addScaledVector(dir, far).toArray(), ...target.toArray(), false);
    } else {
      const visibleHeight = this.orthoHeight / this.orthographic.zoom;
      const d = visibleHeight / (2 * Math.tan(halfFov));
      this.controls.camera = this.perspective;
      this.controls.mouseButtons.wheel = CameraControls.ACTION.DOLLY;
      this.controls.mouseButtons.middle = CameraControls.ACTION.DOLLY;
      void this.controls.setLookAt(...target.clone().addScaledVector(dir, d).toArray(), ...target.toArray(), false);
    }
    this.projection = projection;
    this.gizmo?.setCamera(this.controls.camera);
    this.requestRender();
  }

  /** Animate to a standard view, framing the visible scene; `jaw`: the working tooth's jaw (the occlusal view faces it). */
  setView(view: StandardView, animate = true, jaw?: 'upper' | 'lower'): void {
    const dir = new Vector3(...viewDirection(this.frame, view, jaw));
    if (view === 'occlusal') {
      // Looking along the turntable axis is a gimbal singularity; a tiny
      // offset toward buccal keeps the lingual side at the top of the screen.
      dir.addScaledVector(new Vector3(...this.frame.buccal), 1e-3).normalize();
    }
    this.frameVisible(dir, animate);
  }

  /**
   * Look onto a jaw's biting surfaces, framing the visible scene: from above the lower jaw, from below the upper, tilted
   * a little toward buccal so the teeth read in depth. The view for finding the prep before the tooth has a frame.
   */
  viewJaw(jaw: 'lower' | 'upper', animate = true): void {
    const up = new Vector3(...this.frame.up);
    const dir = (jaw === 'upper' ? up.negate() : up).addScaledVector(new Vector3(...this.frame.buccal), 0.3).normalize();
    this.frameVisible(dir, animate);
  }

  /**
   * Look at `point` from `dirToCamera` at `distanceMm` (e.g. zoom onto the
   * prep from occlusal). Applied to the camera immediately when not animated.
   */
  focus(point: readonly [number, number, number], dirToCamera: readonly [number, number, number], distanceMm: number, animate = true): void {
    const dir = new Vector3(...dirToCamera).normalize();
    // Looking exactly along the turntable axis is a gimbal singularity (see setView).
    if (Math.abs(dir.dot(new Vector3(...this.frame.up))) > 0.999) dir.addScaledVector(new Vector3(...this.frame.buccal), 1e-3).normalize();
    const target = new Vector3(...point);
    const position = target.clone().addScaledVector(dir, distanceMm);
    if (this.projection === 'orthographic') {
      this.orthoHeight = distanceMm * 2 * Math.tan((this.perspective.fov * Math.PI) / 360);
      this.orthographic.zoom = 1;
      this.updateOrthoFrustum();
      position.copy(target).addScaledVector(dir, Math.max(400, distanceMm));
    }
    this.lookAt(position, target, animate);
    if (!animate) this.controls.update(0);
    this.requestRender();
  }

  /** Fit the visible scene, keeping the current viewing direction. */
  fit(animate = true): void {
    const dir = this.controls.getPosition(new Vector3()).sub(this.controls.getTarget(new Vector3())).normalize();
    this.frameVisible(dir, animate);
  }

  /**
   * Translate gizmo in the tooth frame (see TranslateGizmo), or null to hide
   * it. The caller previews the drag from `onDrag` and turns the delta from
   * `onCommit` into commands.
   */
  setGizmo(options: GizmoOptions | null): void {
    if (!options && !this.gizmo) return;
    if (!this.gizmo) {
      this.gizmo = new TranslateGizmo(this.controls.camera, this.renderer.domElement, this.scene, {
        requestRender: () => this.requestRender(),
        setCameraEnabled: (enabled) => {
          this.controls.enabled = enabled;
        },
      });
    }
    this.gizmo.set(options);
  }

  isGizmoDragging(): boolean {
    return this.gizmo?.isDragging ?? false;
  }

  /** Unit direction the camera looks along (from the camera toward the target). */
  viewDirection(): Vector3 {
    return this.controls.getTarget(new Vector3()).sub(this.controls.getPosition(new Vector3())).normalize();
  }

  // ---- picking & output ------------------------------------------------------

  setInteraction(handler: InteractionHandler | null): void {
    if (this.dragging) this.endDrag();
    this.interaction = handler;
    this.renderer.domElement.style.cursor = handler?.cursor ?? '';
  }

  /** Client (CSS pixel) position of a world point, or null if behind the camera. */
  project(point: readonly [number, number, number]): { x: number; y: number } | null {
    const v = new Vector3(...point).project(this.controls.camera);
    if (v.z > 1) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
  }

  /** Normalized device coordinates of a client (CSS pixel) position. */
  private ndc(clientX: number, clientY: number): Vector2 {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  }

  /** BVH-accelerated first hit under a client (CSS pixel) position. */
  raycast(clientX: number, clientY: number, opts: { objectIds?: readonly string[] } = {}): ViewerHit | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.controls.camera);
    this.raycaster.firstHitOnly = true;
    const ids = opts.objectIds;
    const targets = [...this.objects.entries()]
      .filter(([id, o]) => o.mesh.visible && (!ids || ids.includes(id)))
      .map(([, o]) => o.mesh);
    const hits: Intersection[] = this.raycaster.intersectObjects(targets, false);
    const hit = hits[0];
    if (!hit) return null;
    return {
      objectId: hit.object.name,
      point: hit.point.clone(),
      faceIndex: hit.faceIndex ?? -1,
      normal: hit.face?.normal.clone() ?? null,
      distance: hit.distance,
    };
  }

  /** PNG of the current view. Rendered and read back synchronously so no preserveDrawingBuffer is needed. */
  async screenshot(): Promise<Blob> {
    this.orderSeeThrough();
    this.renderer.render(this.scene, this.controls.camera);
    const url = this.renderer.domElement.toDataURL('image/png');
    return (await fetch(url)).blob();
  }

  setBackground(color: string): void {
    const ground = new Color(color);
    this.scene.background = ground;
    const { r, g, b } = ground.getRGB(new Color(), SRGBColorSpace);
    const lift = Math.max(0, SURROUNDINGS_GROUND_FLOOR - (0.299 * r + 0.587 * g + 0.114 * b));
    if (lift !== this.groundLift) {
      this.groundLift = lift;
      for (const obj of this.objects.values()) this.applyLook(obj);
    }
    this.requestRender();
  }

  requestRender(): void {
    this.needsRender = true;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    this.container.removeEventListener('pointerdown', this.onPointerDown, { capture: true });
    this.container.removeEventListener('pointermove', this.onPointerMove);
    this.container.removeEventListener('pointerleave', this.onPointerLeave);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.overlays.clear();
    this.gizmo?.dispose();
    this.gizmo = null;
    for (const t of this.luts.values()) t.dispose();
    this.resizeObserver.disconnect();
    for (const id of [...this.objects.keys()]) this.removeObject(id);
    for (const t of this.matcaps.values()) t.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ---- internals -------------------------------------------------------------

  /** Material state from the object's opacity and focus look. */
  private applyLook(obj: ViewerObject): void {
    const m = obj.mesh.material;
    const focus = obj.focus;
    const opacity = obj.opacity * (focus?.contextOpacity ?? 1);
    setMaterialOpacity(m, opacity);
    m.userData.uniforms.uDesaturate.value = focus?.desaturate ?? 0;
    // The surroundings' veil: (1 − opacity) × the lift, added after premultiplying. Their shading, the gum's tint and
    // how much shows through them stay as on a light ground; only the ground they blend over is lighter.
    const veil = focus && m.transparent ? (1 - opacity) * this.groundLift : 0;
    if (m.premultipliedAlpha !== veil > 0) {
      m.premultipliedAlpha = veil > 0;
      m.needsUpdate = true;
    }
    m.userData.uniforms.uVeil.value = veil;
    // Surroundings sit behind the focus copy and anything coincident with it (the surface default is 1).
    m.polygonOffsetFactor = m.polygonOffsetUnits = focus ? SURROUNDINGS_POLYGON_OFFSET : 1;
    this.syncPrepass(obj);
    const overlay = focus?.overlay;
    if (overlay) {
      const o = overlay.material;
      const useColors = m.vertexColors && Boolean(overlay.geometry.getAttribute('color'));
      if (o.matcap !== m.matcap || o.vertexColors !== useColors) {
        o.matcap = m.matcap;
        o.vertexColors = useColors;
        o.needsUpdate = true;
      }
      setMaterialOpacity(o, obj.opacity);
    }
    this.requestRender();
  }

  /**
   * A see-through object shows only its nearest surface. Its depth-only copy (same geometry, sides and polygon offset)
   * is drawn first in the transparent queue, so the colour pass that follows blends only the object's front-most
   * layer: no inner walls or far sides showing through as streaks. Opaque objects (the crown, the prep in focus) are
   * drawn before both, so they still show through.
   */
  private syncPrepass(obj: ViewerObject): void {
    const m = obj.mesh.material;
    if (!m.transparent) {
      this.disposePrepass(obj);
      obj.mesh.renderOrder = 0;
      return;
    }
    obj.mesh.renderOrder = SEE_THROUGH_ORDER;
    let prepass = obj.prepass;
    if (!prepass) {
      prepass = new Mesh(obj.mesh.geometry, new MeshBasicMaterial({ colorWrite: false, depthWrite: true, transparent: true, side: DoubleSide, polygonOffset: true }));
      prepass.name = `${obj.mesh.name}:prepass`;
      prepass.raycast = () => undefined;
      obj.mesh.add(prepass);
      obj.prepass = prepass;
    }
    prepass.material.polygonOffsetFactor = m.polygonOffsetFactor;
    prepass.material.polygonOffsetUnits = m.polygonOffsetUnits;
  }

  /**
   * See-through objects are drawn back to front, each as its pre-pass then its colour pass, so a nearer one (the
   * antagonist over the prep's jaw, seen from occlusal) blends over the one behind it instead of hiding it.
   */
  private orderSeeThrough(): void {
    const eye = this.controls.camera.position;
    const centre = new Vector3();
    const seeThrough = [...this.objects.values()]
      .filter((o) => o.prepass && o.mesh.visible)
      .map((o) => {
        const g = o.mesh.geometry;
        if (!g.boundingSphere) g.computeBoundingSphere();
        return { o, d: centre.copy(g.boundingSphere!.center).applyMatrix4(o.mesh.matrixWorld).distanceToSquared(eye) };
      })
      .sort((a, b) => b.d - a.d);
    seeThrough.forEach(({ o }, i) => {
      o.prepass!.renderOrder = SEE_THROUGH_ORDER + 2 * i;
      o.mesh.renderOrder = SEE_THROUGH_ORDER + 2 * i + 1;
    });
  }

  private disposePrepass(obj: ViewerObject): void {
    if (!obj.prepass) return;
    obj.mesh.remove(obj.prepass);
    obj.prepass.material.dispose();
    obj.prepass = null;
  }

  private disposeOverlay(obj: ViewerObject): void {
    const overlay = obj.focus?.overlay;
    if (!overlay) return;
    obj.mesh.remove(overlay);
    overlay.geometry.dispose();
    overlay.material.dispose();
    obj.focus = obj.focus && { ...obj.focus, overlay: null };
  }

  /** Lookup texture for a named map or explicit stops (e.g. re-centred per tooth). */
  private lut(map: ColorMapName | ColorStops) {
    const key = typeof map === 'string' ? map : JSON.stringify(map);
    let t = this.luts.get(key);
    if (!t) {
      t = createLutTexture(typeof map === 'string' ? COLOR_MAPS[map] : map);
      this.luts.set(key, t);
    }
    return t;
  }

  private matcap(preset: MatcapPreset) {
    let t = this.matcaps.get(preset);
    if (!t) {
      t = createMatcap(MATCAP_PRESETS[preset]);
      this.matcaps.set(preset, t);
    }
    return t;
  }

  private size(): { width: number; height: number } {
    return { width: Math.max(1, this.container.clientWidth), height: Math.max(1, this.container.clientHeight) };
  }

  private updateOrthoFrustum(): void {
    const { width, height } = this.size();
    const aspect = width / height;
    const h = this.orthoHeight / 2;
    this.orthographic.left = -h * aspect;
    this.orthographic.right = h * aspect;
    this.orthographic.top = h;
    this.orthographic.bottom = -h;
    this.orthographic.updateProjectionMatrix();
  }

  private resize(): void {
    const { width, height } = this.size();
    this.renderer.setSize(width, height, false);
    this.perspective.aspect = width / height;
    this.perspective.updateProjectionMatrix();
    this.updateOrthoFrustum();
    this.overlays.setResolution(width, height, this.renderer.getPixelRatio());
    this.requestRender();
  }

  /**
   * Frame the visible meshes for a view direction: project (subsampled)
   * vertices onto the camera basis and fit their extents, which is much
   * tighter than a bounding sphere for a flat, wide dental arch.
   */
  private frameVisible(dirToCamera: Vector3, animate: boolean): void {
    const meshes = [...this.objects.values()].filter((o) => o.mesh.visible).map((o) => o.mesh);
    if (meshes.length === 0) return;
    const forward = dirToCamera.clone().negate().normalize();
    const right = new Vector3().crossVectors(forward, new Vector3(...this.frame.up));
    if (right.lengthSq() < 1e-12) right.set(1, 0, 0);
    right.normalize();
    const up = new Vector3().crossVectors(right, forward).normalize();

    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const mesh of meshes) {
      const p = mesh.geometry.getAttribute('position').array as Float32Array;
      const n = p.length / 3;
      const step = Math.max(1, Math.floor(n / 50_000));
      for (let i = 0; i < n; i += step) {
        const x = p[i * 3]!, y = p[i * 3 + 1]!, z = p[i * 3 + 2]!;
        const u = [x * right.x + y * right.y + z * right.z, x * up.x + y * up.y + z * up.z, x * forward.x + y * forward.y + z * forward.z];
        for (let k = 0; k < 3; k++) {
          if (u[k]! < min[k]!) min[k] = u[k]!;
          if (u[k]! > max[k]!) max[k] = u[k]!;
        }
      }
    }
    const mid = [(min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, (min[2]! + max[2]!) / 2];
    const half = [(max[0]! - min[0]!) / 2, (max[1]! - min[1]!) / 2, (max[2]! - min[2]!) / 2];
    const target = new Vector3()
      .addScaledVector(right, mid[0]!)
      .addScaledVector(up, mid[1]!)
      .addScaledVector(forward, mid[2]!);
    const { width, height } = this.size();
    const aspect = width / height;
    const margin = 1.15;
    const tanHalf = Math.tan((this.perspective.fov * Math.PI) / 360);

    if (this.projection === 'orthographic') {
      this.orthographic.zoom = 1;
      this.orthoHeight = Math.max(2 * half[1]!, (2 * half[0]!) / aspect) * margin;
      this.updateOrthoFrustum();
      const p = target.clone().addScaledVector(dirToCamera, Math.max(400, half[2]! * 4));
      this.lookAt(p, target, animate);
      void this.controls.zoomTo(1, animate);
    } else {
      // Distance so the front face of the extents box fits both axes.
      const fitDistance = Math.max(half[1]! / tanHalf, half[0]! / (tanHalf * aspect)) * margin + half[2]!;
      const p = target.clone().addScaledVector(dirToCamera, fitDistance);
      this.lookAt(p, target, animate);
    }
    this.requestRender();
  }

  private toolHit(event: PointerEvent): ViewerHit | null {
    const ids = this.interaction?.targets?.();
    return this.raycast(event.clientX, event.clientY, ids ? { objectIds: ids } : {});
  }

  private endDrag(event?: PointerEvent): void {
    this.dragging = false;
    this.controls.enabled = true;
    if (event) this.interaction?.onDragEnd?.(event);
  }

  /**
   * Move the camera. Cursor-centric orbit (setOrbitPoint) leaves a focal
   * offset behind; clear it, or the camera ends up shifted from the
   * requested view.
   */
  private lookAt(position: Vector3, target: Vector3, animate: boolean): void {
    void this.controls.setFocalOffset(0, 0, 0, animate);
    void this.controls.setLookAt(position.x, position.y, position.z, target.x, target.y, target.z, animate);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== MOUSE.LEFT && event.button !== MOUSE.RIGHT && event.button !== MOUSE.MIDDLE) return;
    if (event.button === MOUSE.LEFT && this.gizmo?.hitTest(this.ndc(event.clientX, event.clientY))) {
      // TransformControls (also on the canvas) starts the drag; keep camera-controls and tools out of it.
      this.gizmoPress = true;
      this.pointerDown = null;
      this.controls.enabled = false;
      return;
    }
    if (event.button === MOUSE.LEFT && this.interaction?.onDragStart?.(event)) {
      // The tool owns this drag: keep camera-controls (which listens on the canvas, after this capture listener) out of it.
      this.dragging = true;
      this.controls.enabled = false;
      return;
    }
    this.pointerDown = event.button === MOUSE.LEFT ? { x: event.clientX, y: event.clientY, t: performance.now() } : null;
    const hit = this.raycast(event.clientX, event.clientY);
    if (hit) this.controls.setOrbitPoint(hit.point.x, hit.point.y, hit.point.z);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.gizmoPress) return;
    if (this.dragging) {
      this.interaction?.onDrag?.(this.toolHit(event), event);
      return;
    }
    if (event.buttons !== 0 || !this.interaction?.onHover) return;
    // Throttle hover picking to one raycast per animation frame.
    const pending = this.hoverEvent;
    this.hoverEvent = event;
    if (pending) return;
    requestAnimationFrame(() => {
      const e = this.hoverEvent;
      this.hoverEvent = null;
      if (e && !this.dragging) this.interaction?.onHover?.(this.toolHit(e), e);
    });
  };

  private readonly onPointerLeave = (event: PointerEvent): void => {
    if (!this.dragging) this.interaction?.onHover?.(null, event);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.gizmoPress) {
      this.gizmoPress = false;
      if (!this.gizmo?.isDragging) this.controls.enabled = true;
      return;
    }
    if (this.dragging) {
      this.endDrag(event);
      return;
    }
    const down = this.pointerDown;
    this.pointerDown = null;
    if (!down || event.button !== MOUSE.LEFT || !this.interaction?.onClick) return;
    const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
    if (moved > CLICK_SLOP_PX || performance.now() - down.t > CLICK_MAX_MS) return;
    this.interaction.onClick(this.toolHit(event), event);
  };

  private readonly loop = (): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.loop);
    const now = performance.now();
    const delta = (now - this.lastTime) / 1000;
    this.lastTime = now;
    const moved = this.controls.update(delta);
    if (moved || this.needsRender) {
      this.needsRender = false;
      this.orderSeeThrough();
      this.renderer.render(this.scene, this.controls.camera);
    }
  };
}

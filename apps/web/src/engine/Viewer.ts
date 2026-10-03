import CameraControls from 'camera-controls';
import {
  Box3,
  Color,
  Matrix4,
  Mesh,
  MOUSE,
  OrthographicCamera,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  Scene,
  Sphere,
  Spherical,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderer,
  type BufferGeometry,
  type Intersection,
} from 'three';
import { acceleratedRaycast } from 'three-mesh-bvh';
import { createMatcap, MATCAP_PRESETS, type MatcapPreset } from './matcap';
import { createSurfaceMaterial, type SurfaceMaterial } from './materials';
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

interface ViewerObject {
  mesh: Mesh<BufferGeometry, SurfaceMaterial>;
  kind: ObjectKind;
}

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
  private readonly resizeObserver: ResizeObserver;
  private frame: ViewFrame = WORLD_VIEW_FRAME;
  private projection: Projection = 'perspective';
  /** Visible height (mm) of the orthographic frustum at zoom 1. */
  private orthoHeight = 100;
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

    // Cursor-centric orbit: before camera-controls sees the pointerdown
    // (capture phase on the container), orbit around the surface point under
    // the cursor.
    container.addEventListener('pointerdown', this.onPointerDown, { capture: true });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.loop();
  }

  // ---- objects -------------------------------------------------------------

  addObject(id: string, geometry: BufferGeometry, opts: { kind?: ObjectKind; vertexColors?: boolean } = {}): void {
    this.removeObject(id);
    const kind = opts.kind ?? 'jaw';
    const material = createSurfaceMaterial(this.matcap(kind === 'jaw' ? 'stone' : 'tooth'));
    const mesh = new Mesh(geometry, material);
    mesh.name = id;
    mesh.raycast = acceleratedRaycast;
    this.objects.set(id, { mesh, kind });
    this.scene.add(mesh);
    this.setObjectVertexColors(id, Boolean(opts.vertexColors));
    this.requestRender();
  }

  /** Removes the object. The geometry is owned by the caller and is not disposed. */
  removeObject(id: string): void {
    const obj = this.objects.get(id);
    if (!obj) return;
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
    const m = obj.mesh.material;
    const transparent = opacity < 0.999;
    if (m.transparent !== transparent) {
      m.transparent = transparent;
      m.depthWrite = !transparent;
      m.needsUpdate = true;
    }
    m.opacity = opacity;
    m.userData.uniforms.uBackMix.value = transparent ? 0 : 1;
    this.requestRender();
  }

  setObjectVertexColors(id: string, enabled: boolean): void {
    const obj = this.objects.get(id);
    if (!obj) return;
    const m = obj.mesh.material;
    const useColors = enabled && Boolean(obj.mesh.geometry.getAttribute('color'));
    m.vertexColors = useColors;
    m.matcap = this.matcap(useColors ? 'neutral' : obj.kind === 'jaw' ? 'stone' : 'tooth');
    m.needsUpdate = true;
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
    this.requestRender();
  }

  /** Animate to a standard view, framing the visible scene. */
  setView(view: StandardView, animate = true): void {
    const dir = new Vector3(...viewDirection(this.frame, view));
    if (view === 'occlusal') {
      // Looking along the turntable axis is a gimbal singularity; a tiny
      // offset toward buccal keeps the lingual side at the top of the screen.
      dir.addScaledVector(new Vector3(...this.frame.buccal), 1e-3).normalize();
    }
    this.frameVisible(dir, animate);
  }

  /** Fit the visible scene, keeping the current viewing direction. */
  fit(animate = true): void {
    const dir = this.controls.getPosition(new Vector3()).sub(this.controls.getTarget(new Vector3())).normalize();
    this.frameVisible(dir, animate);
  }

  // ---- picking & output ------------------------------------------------------

  /** BVH-accelerated first hit under a client (CSS pixel) position. */
  raycast(clientX: number, clientY: number): ViewerHit | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.controls.camera);
    this.raycaster.firstHitOnly = true;
    const targets = [...this.objects.values()].filter((o) => o.mesh.visible).map((o) => o.mesh);
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
    this.renderer.render(this.scene, this.controls.camera);
    const url = this.renderer.domElement.toDataURL('image/png');
    return (await fetch(url)).blob();
  }

  setBackground(color: string): void {
    this.scene.background = new Color(color);
    this.requestRender();
  }

  requestRender(): void {
    this.needsRender = true;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    this.container.removeEventListener('pointerdown', this.onPointerDown, { capture: true });
    this.resizeObserver.disconnect();
    for (const id of [...this.objects.keys()]) this.removeObject(id);
    for (const t of this.matcaps.values()) t.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ---- internals -------------------------------------------------------------

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
      void this.controls.setLookAt(p.x, p.y, p.z, target.x, target.y, target.z, animate);
      void this.controls.zoomTo(1, animate);
    } else {
      // Distance so the front face of the extents box fits both axes.
      const fitDistance = Math.max(half[1]! / tanHalf, half[0]! / (tanHalf * aspect)) * margin + half[2]!;
      const p = target.clone().addScaledVector(dirToCamera, fitDistance);
      void this.controls.setLookAt(p.x, p.y, p.z, target.x, target.y, target.z, animate);
    }
    this.requestRender();
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== MOUSE.LEFT && event.button !== MOUSE.RIGHT && event.button !== MOUSE.MIDDLE) return;
    const hit = this.raycast(event.clientX, event.clientY);
    if (hit) this.controls.setOrbitPoint(hit.point.x, hit.point.y, hit.point.z);
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
      this.renderer.render(this.scene, this.controls.camera);
    }
  };
}

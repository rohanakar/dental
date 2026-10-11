import { Matrix4, Object3D, Vector2, Vector3, type Camera, type Scene } from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

export type V3 = [number, number, number];

export interface GizmoOptions {
  /** Viewer object moved as a live preview while dragging (e.g. 'crown'). */
  objectId: string;
  /** Where the gizmo sits (e.g. the crown's mid-height centre). */
  position: V3;
  /** Tooth frame; the gizmo's handles follow it. */
  axes: { mesial: V3; buccal: V3; occlusal: V3 };
  onDrag?(deltaWorld: V3): void;
  /** Called once on release with the total world translation (not called for a zero move). */
  onCommit(deltaWorld: V3): void;
}

interface GizmoHost {
  requestRender(): void;
  setCameraEnabled(enabled: boolean): void;
  /** Offset a viewer object for preview, or reset it (null). */
  previewOffset(objectId: string, delta: Vector3 | null): void;
}

/**
 * Translate gizmo (three.js TransformControls, local space) on a proxy
 * oriented to the tooth frame. The proxy basis is (buccal × occlusal,
 * buccal, occlusal), always a proper rotation: the Y handle points buccal
 * and the Z handle occlusal for every quadrant, while the X handle points
 * mesial in right-handed frames (quadrants 2, 4) and distal in left-handed
 * ones (1, 3). Commits are decomposed in world space, so the labels on the
 * handles never matter for the resulting commands.
 */
export class TranslateGizmo {
  private readonly controls: TransformControls;
  private readonly proxy = new Object3D();
  private readonly start = new Vector3();
  private options: GizmoOptions | null = null;
  private dragging = false;

  constructor(
    camera: Camera,
    domElement: HTMLElement,
    private readonly scene: Scene,
    private readonly host: GizmoHost,
  ) {
    this.proxy.name = 'gizmo-proxy';
    scene.add(this.proxy);
    this.controls = new TransformControls(camera, domElement);
    this.controls.setMode('translate');
    this.controls.setSpace('local');
    this.controls.size = 0.8;
    scene.add(this.controls.getHelper());
    this.controls.addEventListener('change', () => host.requestRender());
    this.controls.addEventListener('dragging-changed', (e) => this.onDragging(Boolean((e as unknown as { value: boolean }).value)));
    this.controls.addEventListener('objectChange', () => {
      if (!this.dragging || !this.options) return;
      const delta = this.proxy.position.clone().sub(this.start);
      host.previewOffset(this.options.objectId, delta);
      this.options.onDrag?.(delta.toArray() as V3);
    });
    this.controls.enabled = false;
    this.controls.getHelper().visible = false;
  }

  /** Show the gizmo (or hide it with null). Ignored while a drag is in progress. */
  set(options: GizmoOptions | null): void {
    if (this.dragging) return;
    this.options = options;
    if (!options) {
      this.controls.detach();
      this.controls.enabled = false;
      this.controls.getHelper().visible = false;
      this.host.requestRender();
      return;
    }
    const z = new Vector3(...options.axes.occlusal).normalize();
    const y = new Vector3(...options.axes.buccal).projectOnPlane(z).normalize();
    const x = new Vector3().crossVectors(y, z).normalize();
    this.proxy.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
    this.proxy.position.set(...options.position);
    this.proxy.updateMatrixWorld();
    this.controls.attach(this.proxy);
    this.controls.enabled = true;
    this.controls.getHelper().visible = true;
    this.host.requestRender();
  }

  setCamera(camera: Camera): void {
    this.controls.camera = camera;
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  /** True if the pointer (normalized device coords) is over a gizmo handle. */
  hitTest(ndc: Vector2): boolean {
    if (!this.options || !this.controls.enabled) return false;
    // pointerHover only reads x/y (NDC) and button; the typings ask for a full PointerEvent.
    this.controls.pointerHover({ x: ndc.x, y: ndc.y, button: 0 } as unknown as PointerEvent);
    return this.controls.axis !== null;
  }

  dispose(): void {
    this.controls.detach();
    this.controls.dispose();
    this.scene.remove(this.controls.getHelper());
    this.scene.remove(this.proxy);
  }

  private onDragging(active: boolean): void {
    const options = this.options;
    if (active) {
      this.dragging = true;
      this.start.copy(this.proxy.position);
      this.host.setCameraEnabled(false);
      return;
    }
    if (!this.dragging) return;
    this.dragging = false;
    this.host.setCameraEnabled(true);
    const delta = this.proxy.position.clone().sub(this.start);
    this.proxy.position.copy(this.start);
    this.proxy.updateMatrixWorld();
    if (options) {
      this.host.previewOffset(options.objectId, null);
      if (delta.lengthSq() > 1e-10) options.onCommit(delta.toArray() as V3);
    }
    this.host.requestRender();
  }
}

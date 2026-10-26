import { z } from 'zod';
import {
  bridgesOf,
  CaseSetup,
  DesignParams,
  Fdi,
  FdiPair,
  facingSide,
  connectionMinAreaMm2,
  normalizeConnections,
  pairKey,
  type ProximalSide,
  type UnitKind,
} from './case';
import { Cutback } from './framework';
import { MeshRef, Pose, Vec3 } from './geometry';

export const SCHEMA_VERSION = 1 as const;

export const ScanRole = z.enum(['upper', 'lower', 'preop']);
export type ScanRole = z.infer<typeof ScanRole>;

export const ScanRef = z.object({
  role: ScanRole,
  mesh: MeshRef,
  /** Original file name, for display only. */
  name: z.string().max(256),
});
export type ScanRef = z.infer<typeof ScanRef>;

export const Source = z.enum(['auto', 'manual', 'agent']);
export type Source = z.infer<typeof Source>;

/** Tooth-local frame. All three axes are unit vectors and mutually orthogonal. */
export const ToothFrame = z.object({
  origin: Vec3,
  /** Points from the prep toward the antagonist. */
  occlusal: Vec3,
  /** Points toward the mesial neighbour. */
  mesial: Vec3,
  /** Points toward the cheek (buccal/vestibular). */
  buccal: Vec3,
  mesialContact: Vec3.optional(),
  distalContact: Vec3.optional(),
  source: Source,
});
export type ToothFrame = z.infer<typeof ToothFrame>;

/**
 * Margin as 3D points on the prep surface. faceHint is only a lookup
 * accelerator: face indices are not stable across re-imports or BVH builds.
 */
export const MarginPoint = z.object({
  p: Vec3,
  faceHint: z.number().int().nonnegative().optional(),
});
export const MarginLine = z.object({
  /** User-placed control points (live-wire anchors), in order around the prep. */
  anchors: z.array(MarginPoint).min(3),
  /** Dense resampled closed curve derived from the anchors. */
  points: z.array(MarginPoint),
  source: Source,
});
export type MarginLine = z.infer<typeof MarginLine>;

export const InsertionAxis = z.object({
  direction: Vec3,
  source: Source,
});
export type InsertionAxis = z.infer<typeof InsertionAxis>;

/**
 * Crown geometry is either a library template deformed onto the margin
 * (classical pipeline) or an arbitrary mesh (e.g. produced by an ML model).
 */
/**
 * Adaptation targets. Stored as settings (not displacements): the crown is
 * re-derived from pose + params + these targets, so edits and undo stay cheap.
 */
export const CrownAdapt = z.object({
  /** Target clearance to the antagonist (negative = intentional contact). */
  occlusion: z.object({ clearanceMm: z.number().min(-0.2).max(1) }).optional(),
  /** Target gap to the mesial / distal neighbour (negative = tighter contact). */
  mesial: z.object({ targetMm: z.number().min(-0.2).max(0.5) }).optional(),
  distal: z.object({ targetMm: z.number().min(-0.2).max(0.5) }).optional(),
});
export type CrownAdapt = z.infer<typeof CrownAdapt>;

export const TemplateCrown = z.object({
  kind: z.literal('template'),
  templateId: z.string(),
  /** Pose of the template in the tooth frame. */
  pose: Pose,
  adapt: CrownAdapt.optional(),
  /** Sculpt displacements stored in the crown's local frame (not used yet). */
  deltas: MeshRef.optional(),
});
export const MeshCrown = z.object({
  kind: z.literal('mesh'),
  mesh: MeshRef,
});
export const Crown = z.discriminatedUnion('kind', [TemplateCrown, MeshCrown]);
export type Crown = z.infer<typeof Crown>;

export const StepId = z.enum([
  'setup',
  'scans',
  'frame',
  'margin',
  'axis',
  'params',
  'proposal',
  'adapt',
  'finalize',
]);
export type StepId = z.infer<typeof StepId>;
export const STEP_ORDER: readonly StepId[] = StepId.options;

export const StepStatus = z.enum(['pending', 'done', 'stale']);
export type StepStatus = z.infer<typeof StepStatus>;

/** Exhaustive by design: every tooth tracks all steps. Start from initialSteps(). */
export const initialSteps = (): Record<StepId, StepStatus> =>
  Object.fromEntries(STEP_ORDER.map((s) => [s, 'pending'])) as Record<StepId, StepStatus>;

/**
 * Implant crowns: the scan-body match (the "Implant position" step, stored in the margin step). The pose places the
 * library frame (platform centre, implant axis +z, anti-rotation flat +x) in the scan.
 */
export const ImplantDesign = z.object({
  /** Library entry key, `${library id}/${entry id}`, e.g. 'synthetic-generic@1/rp-non-engaging'. */
  libraryId: z.string().min(1),
  scanBodyPose: Pose,
  /** Engaging Ti-base (single units); bridges use non-engaging ones. */
  engaging: z.boolean(),
  /** The library's largest angled-screw-channel angle (setScrewChannel is refused above it). */
  ascMaxDeg: z.number().min(0).max(45),
  /** Registration quality (scanBody.ts). */
  fit: z.object({
    rmsMm: z.number().nonnegative(),
    maxMm: z.number().nonnegative(),
    inlierFraction: z.number().min(0).max(1),
    coverage: z.number().min(0).max(1).optional(),
  }),
  source: Source,
});
export type ImplantDesign = z.infer<typeof ImplantDesign>;

/** Angled screw channel: 0° runs along the implant axis; the azimuth is measured about it from buccal toward mesial. */
export const ScrewChannel = z.object({
  angleDeg: z.number().min(0).max(45),
  azimuthDeg: z.number().min(-360).max(360),
});
export type ScrewChannel = z.infer<typeof ScrewChannel>;

/** Where an inlay's or onlay's outer surface comes from: the pre-op scan (exact) or the library tooth fitted to the tooth. */
export const OuterSource = z.enum(['preop', 'library']);
export type OuterSource = z.infer<typeof OuterSource>;

export const ToothDesign = z.object({
  fdi: Fdi,
  params: DesignParams,
  frame: ToothFrame.optional(),
  margin: MarginLine.optional(),
  axis: InsertionAxis.optional(),
  crown: Crown.optional(),
  /** Implant crowns: the scan-body match (instead of a margin). */
  implant: ImplantDesign.optional(),
  /** Implant crowns: the screw channel; omitted = straight. */
  screwChannel: ScrewChannel.optional(),
  steps: z.record(StepId, StepStatus),
  /** Reduced units: how the anatomy is cut back (omitted = CUTBACK_DEFAULTS). Kept when the unit switches back to anatomic. */
  cutback: Cutback.optional(),
  /** Inlays and onlays: the outer surface's chosen source (outerSourceOf: without a pre-op scan it is the library). */
  outerSource: OuterSource.optional(),
});
export type ToothDesign = z.infer<typeof ToothDesign>;

/**
 * The outer source an inlay or onlay uses: the pre-op scan while the case has one, unless the library tooth was chosen;
 * the library tooth without a pre-op scan (whatever was chosen).
 */
export function outerSourceOf(doc: { scans: ReadonlyArray<{ role: ScanRole }>; teeth: ReadonlyArray<Pick<ToothDesign, 'fdi' | 'outerSource'>> }, fdi: number): OuterSource {
  const preop = doc.scans.some((s) => s.role === 'preop');
  return preop && doc.teeth.find((t) => t.fdi === fdi)?.outerSource !== 'library' ? 'preop' : 'library';
}

/** Connector cross-section limits; the material minimum (minConnectorAreaMm2) is enforced by the reducer. */
export const ConnectorArea = z.number().min(1).max(50);
/** Connector offsets from its automatic position. */
export const ConnectorOffset = z.number().min(-2).max(2);

/** Connector settings. The connector itself is derived geometry: it follows its units when they move. */
export const ConnectorDesign = z.object({
  /** The connected units, sorted ascending. */
  between: FdiPair,
  /** Designed cross-section; defaults to the material minimum and never goes below it. */
  areaMm2: ConnectorArea,
  /** Offset toward buccal (negative = lingual). */
  buccalMm: ConnectorOffset,
  /** Offset toward occlusal (negative = cervical). */
  occlusalMm: ConnectorOffset,
});
export type ConnectorDesign = z.infer<typeof ConnectorDesign>;

/** A bridge: a connected component of the setup's connections. Derived by setCaseSetup; connectors keep their settings. */
export const BridgeDesign = z.object({
  /** Units in arch order. */
  teeth: z.array(Fdi).min(2),
  /** One per connection, in arch order. */
  connectors: z.array(ConnectorDesign),
});
export type BridgeDesign = z.infer<typeof BridgeDesign>;

export const DesignDocument = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  caseId: z.string(),
  setup: CaseSetup,
  scans: z.array(ScanRef),
  teeth: z.array(ToothDesign),
  bridges: z.array(BridgeDesign).default([]),
});
export type DesignDocument = z.infer<typeof DesignDocument>;

/**
 * The bridges of a setup with their connectors. Connectors of connections that still exist keep their settings
 * (raised to the material minimum if needed); new ones get the material minimum and no offset.
 */
export function deriveBridges(setup: Pick<CaseSetup, 'teeth' | 'connections'>, previous: readonly BridgeDesign[] = []): BridgeDesign[] {
  const kept = new Map(previous.flatMap((b) => b.connectors).map((c) => [pairKey(c.between), c] as const));
  const connections = normalizeConnections(setup.connections);
  return bridgesOf(setup).map((teeth) => {
    const connectors = connections
      .filter(([a, b]) => a !== b && teeth.includes(a) && teeth.includes(b))
      .map((between): ConnectorDesign => {
        const [a, b] = between;
        const min = connectionMinAreaMm2(setup.teeth, a, b);
        const old = kept.get(pairKey(between));
        if (!old) return { between, areaMm2: min, buccalMm: 0, occlusalMm: 0 };
        return old.areaMm2 >= min ? old : { ...old, areaMm2: min };
      });
    return { teeth, connectors };
  });
}

export const bridgeOf = (doc: Pick<DesignDocument, 'bridges'>, fdi: number): BridgeDesign | undefined =>
  doc.bridges.find((b) => b.teeth.includes(fdi));

/** The proximal sides of a unit that face a connected unit: they get a connector, not a contact. */
export function connectedSides(doc: Pick<DesignDocument, 'bridges'>, fdi: number): ProximalSide[] {
  const connectors = bridgeOf(doc, fdi)?.connectors ?? [];
  return connectors.filter((c) => c.between.includes(fdi)).map(({ between: [a, b] }) => facingSide(fdi, a === fdi ? b : a));
}

/** The design steps of a unit. A pontic has no prep: it skips the margin and the insertion axis. */
export const stepsFor = (kind: UnitKind): readonly StepId[] =>
  kind === 'pontic' ? STEP_ORDER.filter((s) => s !== 'margin' && s !== 'axis') : STEP_ORDER;

/**
 * Steps downstream of a changed step become stale and must be re-run.
 * Returns the steps invalidated by a change to `changed`.
 */
export function downstreamSteps(changed: StepId): StepId[] {
  const i = STEP_ORDER.indexOf(changed);
  return STEP_ORDER.slice(i + 1);
}

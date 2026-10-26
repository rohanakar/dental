import { z } from 'zod';

/** FDI two-digit tooth number: quadrant 1-4, position 1-8. */
export const Fdi = z
  .number()
  .int()
  .min(11)
  .max(48)
  .refine((n) => {
    const q = Math.floor(n / 10);
    const p = n % 10;
    return q >= 1 && q <= 4 && p >= 1 && p <= 8;
  }, 'FDI tooth number (11-18, 21-28, 31-38, 41-48)');
export type Fdi = z.infer<typeof Fdi>;

/**
 * Two teeth, e.g. the ends of a connection. Parsed as a tuple, but its input JSON schema is a plain two-item array:
 * LLM tool schemas must not contain `prefixItems` (OpenAI strict mode rejects them).
 */
export const FdiPair = z.array(Fdi).length(2).pipe(z.tuple([Fdi, Fdi]));
export type FdiPair = z.infer<typeof FdiPair>;

export type Jaw = 'upper' | 'lower';
export const jawOf = (fdi: number): Jaw => (Math.floor(fdi / 10) <= 2 ? 'upper' : 'lower');
/** Premolars and molars (positions 4-8). A connector is posterior if either of its units is. */
export const isPosterior = (fdi: number): boolean => fdi % 10 >= 4;

/**
 * Position along the jaw's arch, 0-15: upper 18→11 then 21→28, lower 48→41 then 31→38. Neighbours in the arch
 * differ by 1, also across the midline.
 */
export function archIndex(fdi: number): number {
  const quadrant = Math.floor(fdi / 10);
  const position = fdi % 10;
  return quadrant === 1 || quadrant === 4 ? 8 - position : 7 + position;
}

const archRank = (fdi: number): number => (jawOf(fdi) === 'upper' ? 0 : 16) + archIndex(fdi);

/** Teeth sorted in arch order: upper jaw first (18→28), then the lower jaw (48→38). */
export const archOrder = <T extends number>(fdis: readonly T[]): T[] => [...fdis].sort((a, b) => archRank(a) - archRank(b));

/** Neighbours in the tooth chart: same quadrant and positions differ by 1, or 11–21, or 31–41. */
export const chartAdjacent = (a: number, b: number): boolean => jawOf(a) === jawOf(b) && Math.abs(archIndex(a) - archIndex(b)) === 1;

export type ProximalSide = 'mesial' | 'distal';

/** The proximal side of `a` that faces `b` (same jaw). Mesial points toward the midline, so 11–21 is mesial on both. */
export function facingSide(a: number, b: number): ProximalSide {
  if (jawOf(a) !== jawOf(b)) throw new Error(`Teeth ${a} and ${b} are in different jaws`);
  if (Math.floor(a / 10) !== Math.floor(b / 10)) return 'mesial';
  return b % 10 < a % 10 ? 'mesial' : 'distal';
}

export const RestorationType = z.enum(['anatomic-crown', 'pontic', 'maryland-wing', 'implant-crown', 'reduced-crown', 'reduced-pontic']);
export type RestorationType = z.infer<typeof RestorationType>;

/** What a unit is in a bridge: an abutment sits on a prep (retainer), a pontic replaces a missing tooth. */
export type UnitKind = 'abutment' | 'pontic';

export interface RestorationRole {
  role: UnitKind;
  /** Whether this type permits connectors at all (exocad creates none otherwise). */
  connectors: boolean;
  /** When set, connectors are permitted only to units of these types. */
  connectsTo?: readonly RestorationType[];
  /** A reduced (cut-back) unit: designed as the anatomy, then cut back by ToothDesign.cutback (framework.ts). */
  reduced?: boolean;
}

/**
 * The bridge core (validation, steps, unit dispatch) reads the role, never the type, so a new restoration type is
 * one entry here plus its geometry.
 */
export const RESTORATION_ROLE: Record<RestorationType, RestorationRole> = {
  'anatomic-crown': { role: 'abutment', connectors: true },
  pontic: { role: 'pontic', connectors: true },
  /** Resin-bonded (Maryland) wing on an unprepared abutment: connects to pontics and other wings only. */
  'maryland-wing': { role: 'abutment', connectors: true, connectsTo: ['pontic', 'reduced-pontic', 'maryland-wing'] },
  /** Screw-retained on a library Ti-base: the scan-body match replaces the margin (specs/2026-10-25-implant-bridges.md). */
  'implant-crown': { role: 'abutment', connectors: true },
  'reduced-crown': { role: 'abutment', connectors: true, reduced: true },
  'reduced-pontic': { role: 'pontic', connectors: true, reduced: true },
};

/** Abutments supported by an implant (not a prepared tooth). A bridge may not mix the two supports. */
export const isImplantRestoration = (restoration: RestorationType): boolean => restoration === 'implant-crown';

export const Material = z.enum(['zirconia', 'lithium-disilicate', 'pmma', 'cocr', 'titanium']);
export type Material = z.infer<typeof Material>;

export interface BridgePreset {
  /** Minimum connector cross-section. A connector is posterior if either unit is a premolar or molar. */
  connectorMinAreaMm2: { anterior: number; posterior: number };
  connectorMinHeightMm: number;
  /** The manufacturer's indication; a bridge outside it raises a warning, never an error. */
  indication?: { maxUnits?: number; /** Most distal tooth position (1-8) a unit may take. */ maxPosition?: number };
}

/** Connector minimums per material. Defaults to confirm in domain QA against the material IFU. */
export const BRIDGE_PRESETS: Record<Material, BridgePreset> = {
  zirconia: { connectorMinAreaMm2: { anterior: 7, posterior: 9 }, connectorMinHeightMm: 3.0 },
  'lithium-disilicate': {
    connectorMinAreaMm2: { anterior: 12, posterior: 16 },
    connectorMinHeightMm: 3.0,
    indication: { maxUnits: 3, maxPosition: 5 },
  },
  pmma: { connectorMinAreaMm2: { anterior: 9, posterior: 12 }, connectorMinHeightMm: 3.0 },
  // Metal frameworks (cobalt-chromium milled or SLM, titanium): placeholders to confirm with the lab and the alloy IFU.
  cocr: { connectorMinAreaMm2: { anterior: 4, posterior: 6 }, connectorMinHeightMm: 3.0 },
  titanium: { connectorMinAreaMm2: { anterior: 6, posterior: 9 }, connectorMinHeightMm: 3.0 },
};

export const minConnectorAreaMm2 = (material: Material, a: number, b: number): number =>
  BRIDGE_PRESETS[material].connectorMinAreaMm2[isPosterior(a) || isPosterior(b) ? 'posterior' : 'anterior'];

/**
 * Connectors of a Maryland wing: at least 3 mm high and 2 mm wide (Kern's zirconia RBFDP guidance, the strictest
 * published), for every material. It replaces the material area minimum: a wing's connector sits lingual of the
 * contact area, where a 3 × 3 mm section does not fit, so it may be narrower than high.
 */
export const MARYLAND_CONNECTOR = { minHeightMm: 3, minWidthMm: 2 } as const;
/** The Maryland minimum as an area: the ellipse of 3 × 2 mm (π/4 · 6 = 4.712), rounded up to 0.01 mm². */
export const MARYLAND_CONNECTOR_MIN_AREA_MM2 = Math.ceil(((Math.PI / 4) * MARYLAND_CONNECTOR.minHeightMm * MARYLAND_CONNECTOR.minWidthMm) * 100) / 100;

/** The minimum connector area between two teeth of a setup: the Maryland minimum next to a wing, else the material's. */
export function connectionMinAreaMm2(teeth: ReadonlyArray<{ fdi: number; restoration: RestorationType; material: Material }>, a: number, b: number): number {
  const ta = teeth.find((t) => t.fdi === a), tb = teeth.find((t) => t.fdi === b);
  if (ta?.restoration === 'maryland-wing' || tb?.restoration === 'maryland-wing') return MARYLAND_CONNECTOR_MIN_AREA_MM2;
  return Math.max(0, ...[ta, tb].filter((t) => t !== undefined).map((t) => minConnectorAreaMm2(t.material, a, b)));
}

export const DesignParams = z.object({
  /** Cement gap applied beyond the margin ramp. */
  cementGapMm: z.number().min(0).max(0.3),
  /** Additional spacer applied beyond distanceToMarginMm. */
  extraSpacerMm: z.number().min(0).max(0.3),
  /** Distance from the margin where the extra spacer starts. */
  distanceToMarginMm: z.number().min(0).max(3),
  /** Restoration thickness at the margin. */
  marginThicknessMm: z.number().min(0).max(1),
  /** Minimum restoration thickness away from the margin. */
  minThicknessMm: z.number().min(0.2).max(3),
  /** Milling tool radius; used only for the "unmillable" map, not for compensation. */
  toolRadiusMm: z.number().min(0).max(1.5),
  /** Target occlusal clearance to the antagonist (negative = intentional contact). */
  occlusalClearanceMm: z.number().min(-0.2).max(1),
  /** Target proximal contact distance to neighbours (negative = tighter contact). */
  proximalContactMm: z.number().min(-0.2).max(0.5),
  /** Pontics only: gap between the pontic base and the ridge (0 = passive contact, negative = pressure). */
  ponticRidgeGapMm: z.number().min(-0.3).max(3).default(0),
  /** Maryland wings only: wing thickness (default 0.7 mm; it is never thinned below 0.5 mm). */
  wingThicknessMm: z.number().min(0.5).max(1.5).optional(),
  /** Maryland wings only: thickness at the outline, rising to the wing thickness within 1 mm (default 0.2 mm). */
  wingEdgeThicknessMm: z.number().min(0.05).max(0.5).optional(),
  /** Implant crowns only: bonding gap to the Ti-base; omitted = the library's. */
  tiBaseGapMm: z.number().min(0).max(0.2).optional(),
  /** Implant crowns only: minimum material around the screw channel; omitted = 0.8 mm. */
  channelWallMm: z.number().min(0.3).max(2).optional(),
  /** Implant crowns only: emergence profile, 0 = straight from the Ti-base shoulder, 1 = concave; omitted = 0.5. */
  emergenceConcavity: z.number().min(0).max(1).optional(),
});
export type DesignParams = z.infer<typeof DesignParams>;

export const MATERIAL_PRESETS: Record<Material, DesignParams> = {
  zirconia: {
    cementGapMm: 0.03,
    extraSpacerMm: 0.04,
    distanceToMarginMm: 1.0,
    marginThicknessMm: 0.1,
    minThicknessMm: 0.5,
    toolRadiusMm: 0.5,
    occlusalClearanceMm: 0.05,
    proximalContactMm: 0.02,
    ponticRidgeGapMm: 0,
  },
  'lithium-disilicate': {
    cementGapMm: 0.04,
    extraSpacerMm: 0.05,
    distanceToMarginMm: 1.0,
    marginThicknessMm: 0.15,
    minThicknessMm: 1.0,
    toolRadiusMm: 0.5,
    occlusalClearanceMm: 0.05,
    proximalContactMm: 0.02,
    ponticRidgeGapMm: 0,
  },
  pmma: {
    cementGapMm: 0.05,
    extraSpacerMm: 0.05,
    distanceToMarginMm: 1.0,
    marginThicknessMm: 0.2,
    minThicknessMm: 1.0,
    toolRadiusMm: 0.5,
    occlusalClearanceMm: 0.05,
    proximalContactMm: 0.02,
    ponticRidgeGapMm: 0,
  },
  // Metal frameworks: minThicknessMm is the framework minimum under the veneer; cement gap and spacer as for zirconia.
  cocr: {
    cementGapMm: 0.03,
    extraSpacerMm: 0.04,
    distanceToMarginMm: 1.0,
    marginThicknessMm: 0.1,
    minThicknessMm: 0.3,
    toolRadiusMm: 0.5,
    occlusalClearanceMm: 0.05,
    proximalContactMm: 0.02,
    ponticRidgeGapMm: 0,
  },
  titanium: {
    cementGapMm: 0.03,
    extraSpacerMm: 0.04,
    distanceToMarginMm: 1.0,
    marginThicknessMm: 0.1,
    minThicknessMm: 0.4,
    toolRadiusMm: 0.5,
    occlusalClearanceMm: 0.05,
    proximalContactMm: 0.02,
    ponticRidgeGapMm: 0,
  },
};

export const ToothOrder = z.object({
  fdi: Fdi,
  restoration: RestorationType,
  material: Material,
  shade: z.string().max(32).optional(),
});
export type ToothOrder = z.infer<typeof ToothOrder>;

/**
 * Case setup as entered by the user or extracted from an Rx by the LLM.
 * patientRef is a pseudonymous reference; never a patient name.
 */
export const CaseSetup = z.object({
  patientRef: z.string().max(64),
  teeth: z.array(ToothOrder).min(1),
  notes: z.string().max(4000).default(''),
  /**
   * Connected neighbours, as ordered: each pair sorted ascending. A bridge is a connected component of this graph;
   * check a setup with validateBridges().
   */
  connections: z.array(FdiPair).default([]),
});
export type CaseSetup = z.infer<typeof CaseSetup>;

// ---- Bridges ------------------------------------------------------------------

export const sortedPair = (a: number, b: number): FdiPair => (a <= b ? [a, b] : [b, a]);
export const pairKey = ([a, b]: readonly [number, number]): string => sortedPair(a, b).join('-');

/** Connections as stored: each pair sorted ascending, no duplicates, listed in arch order. */
export function normalizeConnections(connections: readonly (readonly [number, number])[]): FdiPair[] {
  const byKey = new Map(connections.map(([a, b]) => [pairKey([a, b]), sortedPair(a, b)] as const));
  const lo = ([a, b]: FdiPair) => Math.min(archRank(a), archRank(b));
  const hi = ([a, b]: FdiPair) => Math.max(archRank(a), archRank(b));
  return [...byKey.values()].sort((p, q) => lo(p) - lo(q) || hi(p) - hi(q));
}

/** The unit kind of a tooth in the setup. Teeth outside the setup count as abutments (the single-crown case). */
export function unitKind(setup: Pick<CaseSetup, 'teeth'>, fdi: number): UnitKind {
  const order = setup.teeth.find((t) => t.fdi === fdi);
  return order ? RESTORATION_ROLE[order.restoration].role : 'abutment';
}

/**
 * The bridges of a setup: connected components of the connection graph with two or more teeth, each in arch order.
 * Connections to teeth outside the setup are ignored. Splinted crowns (no pontic) are bridges too.
 */
export function bridgesOf(setup: Pick<CaseSetup, 'teeth' | 'connections'>): Fdi[][] {
  const inCase = new Set(setup.teeth.map((t) => t.fdi));
  const links = new Map<number, number[]>();
  for (const [a, b] of setup.connections) {
    if (!inCase.has(a) || !inCase.has(b) || a === b) continue;
    links.set(a, [...(links.get(a) ?? []), b]);
    links.set(b, [...(links.get(b) ?? []), a]);
  }
  const seen = new Set<number>();
  const bridges: Fdi[][] = [];
  for (const start of archOrder([...links.keys()])) {
    if (seen.has(start)) continue;
    const component: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const fdi = stack.pop()!;
      component.push(fdi);
      for (const next of links.get(fdi) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    bridges.push(archOrder(component));
  }
  return bridges;
}

export type BridgeIssueCode =
  /** A connection names a tooth that is not in the case. */
  | 'unknown-tooth'
  /** A connection between teeth that are not neighbours in the tooth chart. */
  | 'not-adjacent'
  /** A connection between teeth of different materials (no connector, as in exocad). */
  | 'mixed-materials'
  /** A connection involving a restoration type that does not permit it. */
  | 'connector-not-permitted'
  /** A bridge with no abutment: nothing holds it in place. */
  | 'no-abutment'
  /** A pontic with no connection. */
  | 'unconnected-pontic'
  /** A bridge with both implant and natural-tooth abutments (refused: the supports move differently). */
  | 'mixed-support'
  /** Warning: more units than the material is indicated for. */
  | 'indication-units'
  /** Warning: a unit further distal than the material is indicated for. */
  | 'indication-position';

export interface BridgeIssue {
  code: BridgeIssueCode;
  message: string;
  teeth: Fdi[];
}

export interface BridgeValidation {
  /** The setup is refused (setCaseSetup throws). */
  errors: BridgeIssue[];
  /** Outside a material's indication: shown, never refused. */
  warnings: BridgeIssue[];
}

const MATERIAL_LABEL: Record<Material, string> = { zirconia: 'Zirconia', 'lithium-disilicate': 'Lithium disilicate', pmma: 'PMMA', cocr: 'CoCr', titanium: 'Titanium' };

/**
 * Check a setup's bridges. Any span, cantilevers, midline bridges and splinted crowns are valid; the errors are the
 * physical rules (adjacency, one material per connection, an abutment per bridge, no loose pontic) and the warnings
 * the materials' indications.
 */
export function validateBridges(setup: Pick<CaseSetup, 'teeth' | 'connections'>): BridgeValidation {
  const errors: BridgeIssue[] = [];
  const warnings: BridgeIssue[] = [];
  const order = new Map(setup.teeth.map((t) => [t.fdi, t] as const));
  const connected = new Set<number>();

  for (const [a, b] of setup.connections) {
    const teeth: Fdi[] = [a, b];
    const [oa, ob] = [order.get(a), order.get(b)];
    if (!oa || !ob) {
      errors.push({ code: 'unknown-tooth', message: `Connection ${a}–${b}: tooth ${oa ? b : a} is not in the case`, teeth });
      continue;
    }
    connected.add(a).add(b);
    if (!chartAdjacent(a, b)) {
      errors.push({ code: 'not-adjacent', message: `${a} and ${b} are not neighbours in the tooth chart`, teeth });
    }
    if (oa.material !== ob.material) {
      errors.push({ code: 'mixed-materials', message: `${a} and ${b} have different materials; they cannot be connected`, teeth });
    }
    const [ra, rb] = [RESTORATION_ROLE[oa.restoration], RESTORATION_ROLE[ob.restoration]];
    const permits = (r: RestorationRole, other: RestorationType) => r.connectors && (!r.connectsTo || r.connectsTo.includes(other));
    if (!permits(ra, ob.restoration) || !permits(rb, oa.restoration)) {
      errors.push({ code: 'connector-not-permitted', message: `${oa.restoration} and ${ob.restoration} cannot be connected (${a}–${b})`, teeth });
    }
  }

  for (const t of setup.teeth) {
    if (RESTORATION_ROLE[t.restoration].role === 'pontic' && !connected.has(t.fdi)) {
      errors.push({ code: 'unconnected-pontic', message: `Pontic ${t.fdi} is not connected to a neighbour`, teeth: [t.fdi] });
    }
    // Lithium disilicate wings are indicated for anterior teeth only.
    if (t.restoration === 'maryland-wing' && t.material === 'lithium-disilicate' && isPosterior(t.fdi)) {
      warnings.push({ code: 'indication-position', message: `${MATERIAL_LABEL[t.material]} Maryland wings are indicated for anterior teeth; ${t.fdi} is posterior`, teeth: [t.fdi] });
    }
  }

  for (const teeth of bridgesOf(setup)) {
    const label = teeth.join('–');
    if (!teeth.some((fdi) => unitKind(setup, fdi) === 'abutment')) {
      errors.push({ code: 'no-abutment', message: `Bridge ${label} has no abutment`, teeth });
    }
    const supports = new Set(
      teeth.filter((fdi) => unitKind(setup, fdi) === 'abutment').map((fdi) => isImplantRestoration(order.get(fdi)!.restoration)),
    );
    if (supports.size > 1) {
      errors.push({ code: 'mixed-support', message: `Bridge ${label} mixes implant and natural-tooth abutments`, teeth });
    }
    for (const material of new Set(teeth.map((fdi) => order.get(fdi)!.material))) {
      const indication = BRIDGE_PRESETS[material].indication;
      if (indication?.maxUnits !== undefined && teeth.length > indication.maxUnits) {
        warnings.push({
          code: 'indication-units',
          message: `${MATERIAL_LABEL[material]} bridges are indicated for up to ${indication.maxUnits} units; ${label} has ${teeth.length}`,
          teeth,
        });
      }
      const maxPosition = indication?.maxPosition;
      const beyond = maxPosition === undefined ? [] : teeth.filter((fdi) => fdi % 10 > maxPosition);
      if (beyond.length) {
        warnings.push({
          code: 'indication-position',
          message: `${MATERIAL_LABEL[material]} bridges are indicated up to tooth position ${maxPosition}; ${label} reaches ${beyond.join(', ')}`,
          teeth,
        });
      }
    }
  }
  return { errors, warnings };
}

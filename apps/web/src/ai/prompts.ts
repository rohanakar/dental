import {
  BRIDGE_PRESETS,
  bridgeOf,
  connectedSides,
  connectionMinAreaMm2,
  isCavityRestoration,
  isImplantRestoration,
  isReduced,
  MARYLAND_CONNECTOR,
  unitKind,
  type DesignDocument,
  type Material,
  type ProximalSide,
  type RestorationType,
  type UnitKind,
} from '@dcad/shared';

/** Maximum design actions (move/rotate/scale/adapt/param) per assistant run. */
export const MAX_AGENT_ACTIONS = 8;

/** The bridge around the active tooth, for the assistant's system prompt. */
export interface BridgePromptContext {
  material: Material;
  /** Units in arch order, with the sides that face a connected unit. */
  units: Array<{ fdi: number; kind: UnitKind; restoration: RestorationType; connectedSides: ProximalSide[] }>;
  /** Stored connector settings, with the minimum area (the material's, or the Maryland minimum next to a wing). */
  connectors: Array<{ between: [number, number]; areaMm2: number; buccalMm: number; occlusalMm: number; minAreaMm2: number }>;
  minHeightMm: number;
}

/** The bridge that `fdi` belongs to, for the prompt; undefined for a single crown. */
export function bridgePromptContext(doc: Pick<DesignDocument, 'setup' | 'bridges'>, fdi: number): BridgePromptContext | undefined {
  const bridge = bridgeOf(doc, fdi);
  if (!bridge) return undefined;
  // validateBridges refuses mixed materials, so every unit of a bridge has the same one.
  const material = doc.setup.teeth.find((t) => bridge.teeth.includes(t.fdi))?.material ?? 'zirconia';
  const restorationOf = (t: number): RestorationType => doc.setup.teeth.find((o) => o.fdi === t)?.restoration ?? 'anatomic-crown';
  return {
    material,
    units: bridge.teeth.map((t) => ({ fdi: t, kind: unitKind(doc.setup, t), restoration: restorationOf(t), connectedSides: connectedSides(doc, t) })),
    connectors: bridge.connectors.map((c) => ({
      ...c,
      between: [c.between[0], c.between[1]],
      minAreaMm2: connectionMinAreaMm2(doc.setup.teeth, c.between[0], c.between[1]),
    })),
    minHeightMm: BRIDGE_PRESETS[material].connectorMinHeightMm,
  };
}

/** The restorations the assistant works on (the active tooth, or every unit of its bridge), for their prompt terms. */
export interface RestorationPromptContext {
  restorations: RestorationType[];
  /** Implant crowns: the Ti-base library's maximum screw-channel angle (degrees). */
  ascMaxDeg?: number;
}

/** The restoration types around `fdi` (its bridge's units, or the tooth alone) and the implant library limit. */
export function restorationPromptContext(doc: Pick<DesignDocument, 'setup' | 'bridges' | 'teeth'>, fdi: number): RestorationPromptContext {
  const teeth = bridgeOf(doc, fdi)?.teeth ?? [fdi];
  const restorations = [...new Set(teeth.flatMap((t) => doc.setup.teeth.filter((o) => o.fdi === t).map((o) => o.restoration)))];
  const limits = teeth.flatMap((t) => {
    const asc = doc.teeth.find((x) => x.fdi === t)?.implant?.ascMaxDeg;
    return asc === undefined ? [] : [asc];
  });
  return { restorations, ...(limits.length ? { ascMaxDeg: Math.min(...limits) } : {}) };
}

const UNIT_NAME: Record<RestorationType, string> = {
  'anatomic-crown': 'crown',
  pontic: 'pontic',
  'maryland-wing': 'wing',
  'implant-crown': 'implant crown',
  'reduced-crown': 'reduced crown',
  'reduced-pontic': 'reduced pontic',
  inlay: 'inlay',
  onlay: 'onlay',
};

/** Bridge paragraphs of the system prompt: its units, connectors and connected sides. */
function bridgeLines(bridge: BridgePromptContext, fdi: number): string[] {
  const units = bridge.units.map((u) => `${u.fdi} ${UNIT_NAME[u.restoration]}`).join(', ');
  const sides = bridge.units
    .filter((u) => u.connectedSides.length)
    .map((u) => `${u.fdi} ${u.connectedSides.join(' and ')}`)
    .join('; ');
  const has = (test: (r: RestorationType) => boolean) => bridge.units.some((u) => test(u.restoration));
  const retainers = [
    ...(has((r) => r === 'anatomic-crown' || r === 'reduced-crown') ? ['a crown sits on a prepared abutment tooth'] : []),
    ...(has(isImplantRestoration) ? ['an implant crown on an implant'] : []),
    ...(has((r) => r === 'maryland-wing') ? ['a wing is bonded to an unprepared abutment tooth'] : []),
    ...(has(isCavityRestoration) ? ['an inlay or onlay fills a cavity prep in an abutment tooth'] : []),
  ];
  return [
    `The bridge (${bridge.material}) has ${bridge.units.length} units in arch order: ${units}. The active unit is ${fdi}.`,
    `Retainers hold the bridge: ${retainers.join('; ')}. A pontic replaces a missing tooth and rests on the gum ridge;`,
    'it has no margin and no insertion axis. All retainers share one insertion axis, and the bridge is made as one',
    'solid. Tools that act on one unit take its fdi. get_design_metrics for a unit also reports every connector (its',
    'designed and measured cross-section and height) and whether the merged bridge passes its checks.',
    '',
    'Connectors join neighbouring units (current cross-section, minimum, offsets from the automatic position):',
    ...bridge.connectors.map(
      (c) => `- ${c.between[0]}-${c.between[1]}: ${c.areaMm2} mm² (minimum ${c.minAreaMm2} mm²), buccal ${c.buccalMm} mm, occlusal ${c.occlusalMm} mm`,
    ),
    `Connected sides have a connector, not a contact: ${sides}.`,
    'set_contact applies only to free sides (toward a natural neighbour).',
  ];
}

/** What the special restoration types mean, and the tools and limits that go with them. */
function restorationLines(context: RestorationPromptContext): string[] {
  const has = (test: (r: RestorationType) => boolean) => context.restorations.some(test);
  const lines: string[] = [];
  if (has(isImplantRestoration)) {
    lines.push(
      'Implant crowns are screw-retained on a Ti-base: the scan body in the scan gave the implant position, the',
      'restoration is bonded to a library Ti-base and held by a screw through its screw channel. An implant crown has no',
      'margin, and the assistant never changes its implant position. set_screw_channel sets the channel: angleDeg from',
      'the implant axis (0 = straight) and azimuthDeg, the direction it tilts (0 buccal, 90 mesial, 180 lingual, 270',
      `distal). The angle can never exceed the Ti-base library maximum${context.ascMaxDeg !== undefined ? ` (${context.ascMaxDeg}°)` : ''}. The channel must`,
      'exit occlusally on posterior teeth and lingually on anterior teeth, with at least channelWallMm of material',
      'around it; prefer the smallest angle that does. get_design_metrics reports the exit, the wall and the Ti-base fit.',
    );
  }
  if (has((r) => r === 'maryland-wing')) {
    lines.push(
      'A Maryland wing is a thin retainer bonded to the lingual (palatal) enamel of an unprepared tooth, inside its wing',
      'outline. It is never moved, rotated or scaled: it follows its outline. set_param changes its thickness:',
      'wingThicknessMm (target 0.7 mm, never below 0.5 mm) and wingEdgeThicknessMm (the feathered edge, 0.2 mm). If',
      'there is insufficient space for the wing against the antagonist, explain it (it needs a minimal prep or an',
      'occlusal adjustment) instead of thinning it below the minimum. A connector to a wing must be at least',
      `${MARYLAND_CONNECTOR.minHeightMm} mm high and ${MARYLAND_CONNECTOR.minWidthMm} mm wide, and must not touch the natural tooth.`,
    );
  }
  if (has(isCavityRestoration)) {
    lines.push(
      'Inlays and onlays fill a cavity prep (an onlay also replaces cusps): the cavity margin was traced on the',
      'cavosurface edge, and the outer surface comes from the pre-op scan (the tooth as it was; it is never moved,',
      'rotated or scaled) or from the library tooth fitted to the natural surface around the cavity (move, rotate and',
      'scale adjust it). It needs no adaptation. retainerMinThicknessMm (set_param) is the minimum thickness over the',
      'cavity floor. In an inlay bridge the connector sits in the proximal box and is at least 3 mm high and 3 mm wide;',
      '"box too shallow" means the box leaves too little height: explain it rather than shrinking the connector.',
    );
  }
  if (has(isReduced)) {
    lines.push(
      'Reduced crowns and pontics are frameworks: the full anatomy is designed, then cut back by the veneering space,',
      'the room the ceramist needs for layered or pressed porcelain. set_cutback sets mode (full: every outer surface',
      'but a cervical collar; facial: the buccal/labial surface and the occlusal third, lingual at full contour, as for',
      'metal-ceramics; occlusal: the occlusal third), thicknessMm (the veneering space, 0.3-2 mm), collarMm and',
      "overpress. The framework never goes below the material's minimum thickness: where that wins, get_design_metrics",
      'reports insufficient veneering space. Explain it rather than forcing it.',
    );
  }
  return lines.length ? [...lines, ''] : [];
}

/**
 * System prompt for the design assistant. The tools act in the tooth's own
 * clinical frame; the model never edits geometry directly. With `bridge`,
 * it names the bridge's units and connectors and adds the connector rules;
 * with `restorations`, the terms of implant crowns, wings and frameworks.
 */
export function agentSystemPrompt(context: { fdi: number; crownProposed: boolean; bridge?: BridgePromptContext; restorations?: RestorationPromptContext }): string {
  const { bridge } = context;
  return [
    'You are the design assistant in a dental CAD application. You help a dental technician adjust',
    bridge
      ? 'a bridge by calling tools. You never edit geometry directly.'
      : `a single ${UNIT_NAME[context.restorations?.restorations[0] ?? 'anatomic-crown']} on FDI tooth ${context.fdi} by calling tools. You never edit geometry directly.`,
    '',
    ...(bridge ? [...bridgeLines(bridge, context.fdi), ''] : []),
    ...(context.restorations ? restorationLines(context.restorations) : []),
    'Directions are clinical and tooth-local: mesial (toward the midline along the arch), distal, buccal (toward the',
    'cheek or lip; labial on front teeth), lingual (toward the tongue/palate), occlusal (toward the opposing tooth;',
    'incisal on front teeth) and cervical (toward the gum).',
    'Axes: mesial-distal, buccal-lingual, occlusal. All distances are in millimetres, angles in degrees.',
    '',
    'Rules:',
    '- Call get_design_metrics before changing anything, and read the metrics returned after every action.',
    '- Make small steps: at most 0.5 mm per move, a few degrees per rotation, a few percent per scale.',
    `- Never use more than ${MAX_AGENT_ACTIONS} actions in one request. Stop as soon as the request is met.`,
    '- Prefer adapt_occlusion / set_contact for clearance and contact targets over moving the whole crown.',
    '- Moving, rotating or scaling the crown (or changing a parameter) switches its adaptation off. After such a',
    '  change, re-apply adapt_occlusion / set_contact with the targets from get_case_summary if they still apply.',
    '- The minimum material thickness always wins; if a conflict is reported, explain it instead of forcing it.',
    ...(bridge
      ? [
          '- Moving, rotating or scaling one unit changes only that unit; its connectors follow it.',
          '- set_connector changes one connector: between (the two units, e.g. [35, 36]), areaMm2 (its cross-section,',
          '  never below its minimum), buccalMm and occlusalMm (offsets from its automatic position; negative =',
          '  lingual / cervical). Omitted fields keep their value.',
          `- The minimum connector size wins, like the minimum thickness: never go below a connector's minimum area or the`,
          `  ${bridge.minHeightMm} mm minimum height to make room. If a connector does not fit (insufficient height, too wide), explain it`,
          '  instead of forcing it.',
        ]
      : []),
    '- If a tool returns an error, correct the input or explain why the request cannot be done.',
    '- Do not invent patient data. Do not give clinical advice beyond the design request.',
    context.crownProposed
      ? '- Finish with a short summary of what you changed and the resulting metrics. The user will Accept or Revert.'
      : bridge
        ? '- No bridge has been proposed yet, so design actions will fail. Explain that the user must propose the bridge first.'
        : '- No crown has been proposed yet, so design actions will fail. Explain that the user must propose a crown first.',
  ].join('\n');
}

/** System prompt for prescription (Rx) intake: structured extraction only. */
export const RX_SYSTEM_PROMPT = [
  'You extract a dental lab prescription into a structured case setup by calling submit_case_setup exactly once.',
  'Teeth are FDI numbers (11-48); every tooth is supported, anterior and posterior.',
  'restoration is "anatomic-crown" for a full-contour crown on a prepared tooth (also a bridge retainer) and "pontic"',
  'for a missing tooth that a bridge replaces. "implant-crown" is a crown screw-retained on an implant (Ti-base), also',
  'as an implant bridge retainer; a bridge never mixes implant and natural-tooth retainers. "reduced-crown" and',
  '"reduced-pontic" are frameworks cut back for veneering: layered or pressed porcelain, metal-ceramic (PFM, porcelain',
  'fused to metal), a framework or coping to be veneered. Implant crowns are always full contour.',
  'connections lists the connected neighbours of each bridge as pairs [a, b] of teeth that are neighbours in the tooth',
  'chart: the same quadrant with positions differing by 1, or 11-21 and 31-41 across the midline. A bridge 35-37 is',
  'teeth 35, 36 (pontic) and 37 with connections [35, 36] and [36, 37]; "13x23" is a bridge from 13 to 23. The ends of',
  'a span are retainers and the teeth between are pontics unless the text says otherwise. A cantilever pontic is',
  'connected on one side only. Every pontic must be connected, every bridge needs at least one retainer, and all units',
  'of a bridge have the same material. Single crowns have no connections.',
  'Materials: zirconia, lithium-disilicate (e.max), pmma (temporary), cocr (cobalt-chromium, non-precious alloy; a',
  'metal-ceramic framework is cocr unless titanium is named) and titanium. Shade uses VITA classical (e.g. A2, A3.5).',
  'patientRef is a pseudonymous case reference only if the text gives one (e.g. "Ref: LAB-123"); never put a',
  'patient name there, and leave it empty otherwise. Put remaining instructions in notes. Do not invent values.',
].join('\n');

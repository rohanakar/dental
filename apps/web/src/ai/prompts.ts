import {
  BRIDGE_PRESETS,
  bridgeOf,
  connectedSides,
  minConnectorAreaMm2,
  unitKind,
  type DesignDocument,
  type Material,
  type ProximalSide,
  type UnitKind,
} from '@dcad/shared';

/** Maximum design actions (move/rotate/scale/adapt/param) per assistant run. */
export const MAX_AGENT_ACTIONS = 8;

/** The bridge around the active tooth, for the assistant's system prompt. */
export interface BridgePromptContext {
  material: Material;
  /** Units in arch order, with the sides that face a connected unit. */
  units: Array<{ fdi: number; kind: UnitKind; connectedSides: ProximalSide[] }>;
  /** Stored connector settings, with the material minimum area. */
  connectors: Array<{ between: [number, number]; areaMm2: number; buccalMm: number; occlusalMm: number; minAreaMm2: number }>;
  minHeightMm: number;
}

/** The bridge that `fdi` belongs to, for the prompt; undefined for a single crown. */
export function bridgePromptContext(doc: Pick<DesignDocument, 'setup' | 'bridges'>, fdi: number): BridgePromptContext | undefined {
  const bridge = bridgeOf(doc, fdi);
  if (!bridge) return undefined;
  // validateBridges refuses mixed materials, so every unit of a bridge has the same one.
  const material = doc.setup.teeth.find((t) => bridge.teeth.includes(t.fdi))?.material ?? 'zirconia';
  return {
    material,
    units: bridge.teeth.map((t) => ({ fdi: t, kind: unitKind(doc.setup, t), connectedSides: connectedSides(doc, t) })),
    connectors: bridge.connectors.map((c) => ({ ...c, between: [c.between[0], c.between[1]], minAreaMm2: minConnectorAreaMm2(material, c.between[0], c.between[1]) })),
    minHeightMm: BRIDGE_PRESETS[material].connectorMinHeightMm,
  };
}

const unitName = (kind: UnitKind) => (kind === 'pontic' ? 'pontic' : 'crown');

/** Bridge paragraphs of the system prompt: its units, connectors and connected sides. */
function bridgeLines(bridge: BridgePromptContext, fdi: number): string[] {
  const units = bridge.units.map((u) => `${u.fdi} ${unitName(u.kind)}`).join(', ');
  const sides = bridge.units
    .filter((u) => u.connectedSides.length)
    .map((u) => `${u.fdi} ${u.connectedSides.join(' and ')}`)
    .join('; ');
  return [
    `The bridge (${bridge.material}) has ${bridge.units.length} units in arch order: ${units}. The active unit is ${fdi}.`,
    'A crown is a retainer on a prepared abutment tooth. A pontic replaces a missing tooth and rests on the gum ridge;',
    'it has no margin and no insertion axis. All retainers share one insertion axis, and the bridge is made as one',
    'solid. Tools that act on one unit take its fdi.',
    '',
    'Connectors join neighbouring units (current cross-section, material minimum, offsets from the automatic position):',
    ...bridge.connectors.map(
      (c) => `- ${c.between[0]}-${c.between[1]}: ${c.areaMm2} mm² (minimum ${c.minAreaMm2} mm²), buccal ${c.buccalMm} mm, occlusal ${c.occlusalMm} mm`,
    ),
    `Connected sides have a connector, not a contact: ${sides}.`,
    'set_contact applies only to free sides (toward a natural neighbour).',
  ];
}

/**
 * System prompt for the design assistant. The tools act in the tooth's own
 * clinical frame; the model never edits geometry directly. With `bridge`,
 * it names the bridge's units and connectors and adds the connector rules.
 */
export function agentSystemPrompt(context: { fdi: number; crownProposed: boolean; bridge?: BridgePromptContext }): string {
  const { bridge } = context;
  return [
    'You are the design assistant in a dental CAD application. You help a dental technician adjust',
    bridge
      ? 'a bridge by calling tools. You never edit geometry directly.'
      : `a single crown on FDI tooth ${context.fdi} by calling tools. You never edit geometry directly.`,
    '',
    ...(bridge ? [...bridgeLines(bridge, context.fdi), ''] : []),
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
          '  never below the material minimum), buccalMm and occlusalMm (offsets from its automatic position; negative =',
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
  'restoration is "anatomic-crown" for a crown on a prepared tooth (also a bridge retainer) and "pontic" for a missing',
  'tooth that a bridge replaces.',
  'connections lists the connected neighbours of each bridge as pairs [a, b] of teeth that are neighbours in the tooth',
  'chart: the same quadrant with positions differing by 1, or 11-21 and 31-41 across the midline. A bridge 35-37 is',
  'teeth 35, 36 (pontic) and 37 with connections [35, 36] and [36, 37]; "13x23" is a bridge from 13 to 23. The ends of',
  'a span are retainers and the teeth between are pontics unless the text says otherwise. A cantilever pontic is',
  'connected on one side only. Every pontic must be connected, every bridge needs at least one retainer, and all units',
  'of a bridge have the same material. Single crowns have no connections.',
  'Materials: zirconia, lithium-disilicate (e.max), pmma (temporary). Shade uses VITA classical (e.g. A2, A3.5).',
  'patientRef is a pseudonymous case reference only if the text gives one (e.g. "Ref: LAB-123"); never put a',
  'patient name there, and leave it empty otherwise. Put remaining instructions in notes. Do not invent values.',
].join('\n');

import { z } from 'zod';
import { CaseSetup, DesignParams, Fdi, FdiPair } from './case';
import { ConnectorArea, ConnectorOffset, Crown, ImplantDesign, InsertionAxis, MarginLine, OuterSource, ScanRef, ScanRole, StepId, ToothFrame } from './design';
import { CutbackCollar, CutbackMode, CutbackThickness } from './framework';

/**
 * Every mutation of a DesignDocument is one of these commands. The UI,
 * keyboard shortcuts, the auto-design orchestrator and the LLM agent all go
 * through the same validated path, which gives undo, replay and audit.
 */

// ---- Document commands: set derived/edited state directly (UI + proposers) ----

export const SetCaseSetup = z.object({
  type: z.literal('setCaseSetup'),
  setup: CaseSetup,
});
/** Adds a scan, replacing any existing scan with the same role (one scan per role). */
export const AddScan = z.object({
  type: z.literal('addScan'),
  scan: ScanRef,
});
export const RemoveScan = z.object({
  type: z.literal('removeScan'),
  role: ScanRole,
});
export const SetFrame = z.object({
  type: z.literal('setFrame'),
  fdi: Fdi,
  frame: ToothFrame,
});
export const SetMargin = z.object({
  type: z.literal('setMargin'),
  fdi: Fdi,
  margin: MarginLine,
});
export const SetAxis = z.object({
  type: z.literal('setAxis'),
  fdi: Fdi,
  axis: InsertionAxis,
});
export const SetParams = z.object({
  type: z.literal('setParams'),
  fdi: Fdi,
  params: DesignParams,
});
export const SetCrown = z.object({
  type: z.literal('setCrown'),
  fdi: Fdi,
  crown: Crown,
});
/** Inlays and onlays: the outer surface's source (the proposal is redone). */
export const SetOuterSource = z.object({
  type: z.literal('setOuterSource'),
  fdi: Fdi,
  source: OuterSource,
});
/** Implant crowns: the scan-body match (the "Implant position" step). */
export const SetImplant = z.object({
  type: z.literal('setImplant'),
  fdi: Fdi,
  implant: ImplantDesign,
});

// ---- Clinical commands: tooth-local, exposed to the LLM agent as tools ----

export const ClinicalDirection = z.enum(['mesial', 'distal', 'buccal', 'lingual', 'occlusal', 'cervical']);
export type ClinicalDirection = z.infer<typeof ClinicalDirection>;
export const ClinicalAxis = z.enum(['mesial-distal', 'buccal-lingual', 'occlusal']);
export type ClinicalAxis = z.infer<typeof ClinicalAxis>;

export const MoveCrown = z
  .object({
    type: z.literal('moveCrown'),
    fdi: Fdi,
    direction: ClinicalDirection,
    mm: z.number().min(0).max(2).describe('Distance in millimetres'),
  })
  .describe('Translate the crown along a tooth-local clinical direction.');

export const RotateCrown = z
  .object({
    type: z.literal('rotateCrown'),
    fdi: Fdi,
    axis: ClinicalAxis,
    deg: z.number().min(-30).max(30).describe('Rotation in degrees, right-hand rule about the axis'),
  })
  .describe('Rotate the crown about a tooth-local axis through its centre.');

export const ScaleCrown = z
  .object({
    type: z.literal('scaleCrown'),
    fdi: Fdi,
    axis: ClinicalAxis,
    pct: z.number().min(-20).max(20).describe('Percent change, e.g. -5 shrinks by 5%'),
  })
  .describe('Scale the crown along one tooth-local axis. The margin stays fixed.');

export const SetContact = z
  .object({
    type: z.literal('setContact'),
    fdi: Fdi,
    side: z.enum(['mesial', 'distal']),
    targetMm: z.number().min(-0.2).max(0.5).describe('Target gap to the neighbour; negative = tighter contact'),
  })
  .describe('Adapt the proximal surface so the contact with a neighbour reaches the target distance.');

export const AdaptOcclusion = z
  .object({
    type: z.literal('adaptOcclusion'),
    fdi: Fdi,
    clearanceMm: z.number().min(-0.2).max(1).describe('Target clearance to the antagonist'),
  })
  .describe('Reduce or raise the occlusal surface so clearance to the antagonist reaches the target.');

export const SetConnector = z
  .object({
    type: z.literal('setConnector'),
    between: FdiPair.describe('The two connected bridge units, e.g. [35, 36]'),
    areaMm2: ConnectorArea.optional().describe('Connector cross-section in mm²; never below the material minimum'),
    buccalMm: ConnectorOffset.optional().describe('Move the connector buccally from its automatic position (negative = lingual)'),
    occlusalMm: ConnectorOffset.optional().describe('Move the connector occlusally from its automatic position (negative = cervical)'),
  })
  .describe('Change the connector between two connected bridge units: its cross-section area and position. Omitted fields keep their value.');

export const SetCutback = z
  .object({
    type: z.literal('setCutback'),
    fdi: Fdi,
    mode: CutbackMode.optional().describe('full: every outer surface but the collar; facial: buccal/labial plus the occlusal third; occlusal: the occlusal third'),
    thicknessMm: CutbackThickness.optional().describe('Veneering space in mm: how far the anatomy is cut back for the porcelain'),
    collarMm: CutbackCollar.optional().describe('Collar above the margin kept at full contour, in mm'),
    overpress: z.boolean().optional().describe('Also produce the overpress part (anatomy minus framework) for pressing'),
  })
  .describe('Change how a reduced (framework) unit is cut back for veneering. Omitted fields keep their value.');

export const SetScrewChannel = z
  .object({
    type: z.literal('setScrewChannel'),
    fdi: Fdi,
    angleDeg: z.number().min(0).max(45).describe('Channel angle from the implant axis in degrees; 0 = straight. Never above the library maximum.'),
    azimuthDeg: z.number().min(-360).max(360).describe('Direction of the tilt about the implant axis: 0 = buccal, 90 = mesial, 180 = lingual, 270 = distal'),
  })
  .describe('Set the screw access channel of an implant crown: straight (0°) or angled toward an azimuth, up to the Ti-base library maximum.');

export const SetParam = z
  .object({
    type: z.literal('setParam'),
    fdi: Fdi,
    name: DesignParams.keyof(),
    value: z.number(),
  })
  .describe('Change one design parameter. Downstream steps are recomputed.');

export const RunStep = z
  .object({
    type: z.literal('runStep'),
    fdi: Fdi,
    step: StepId,
  })
  .describe('Run the automatic proposer for one design step.');

export const DOCUMENT_COMMANDS = [SetCaseSetup, AddScan, RemoveScan, SetFrame, SetMargin, SetAxis, SetParams, SetCrown, SetImplant, SetOuterSource] as const;
export const CLINICAL_COMMANDS = [MoveCrown, RotateCrown, ScaleCrown, SetContact, AdaptOcclusion, SetConnector, SetScrewChannel, SetCutback, SetParam, RunStep] as const;

export const Command = z.discriminatedUnion('type', [...DOCUMENT_COMMANDS, ...CLINICAL_COMMANDS]);
export type Command = z.infer<typeof Command>;
export type CommandType = Command['type'];
export type CommandOf<T extends CommandType> = Extract<Command, { type: T }>;
export type ClinicalCommand = z.infer<(typeof CLINICAL_COMMANDS)[number]>;

import { archOrder, connectedSides, type DesignDocument, isReduced, jawOf, type QaCheck, type ToothDesign, unitKind } from '@dcad/shared';
import { bridgeGate } from '../../ai/qa';
import { adaptationStale } from '../../design/adaptation';
import { cutbackFor } from '../../design/framework';
import { bridgeConstructionInfo, bridgeStl, constructionInfo, crownStl } from '../../io/exportCrown';
import { exportAllZip, type OpenCheck, type RestorationExport } from '../../io/exportAllZip';
import { frameworkStl, overpressStl } from '../../io/exportFramework';
import { axisTool } from '../../tools/axisTool';
import { bridgeRequest, unitStatus } from '../../tools/bridgeTool';
import { errorText, toothContextFor } from '../../tools/context';
import { APP_VERSION, crownRequest } from '../../tools/crownTool';
import { frameworkSidecar } from '../../tools/frameworkRequest';
import { isImplantTooth } from '../../tools/implantTool';
import type { ImplantResultView } from '../../workers/analysisTypes';
import { analysis } from '../../workers/geometryClient';
import { IMPLANT_NEEDS, implantReadiness } from './implantReadiness';
import { millReadiness, readinessNeeds, type ReadinessItem } from './readiness';
import { MATERIAL_LABEL } from './SetupStep';

/** A restoration of the case: a single crown, or a bridge (its units in arch order). */
export interface Restoration {
  kind: 'crown' | 'bridge';
  teeth: number[];
  /** "11 crown", "14 implant crown", "21 reduced crown", "bridge 12–22", "framework bridge 35–37". */
  name: string;
}

const restorationOf = (doc: DesignDocument, fdi: number) => doc.setup.teeth.find((t) => t.fdi === fdi)?.restoration;
const reducedUnit = (doc: DesignDocument, fdi: number) => {
  const r = restorationOf(doc, fdi);
  return Boolean(r && isReduced(r));
};

function nameOf(doc: DesignDocument, kind: Restoration['kind'], teeth: readonly number[]): string {
  if (kind === 'bridge') {
    const type = teeth.some((f) => reducedUnit(doc, f)) ? 'framework bridge' : teeth.some((f) => isImplantTooth(doc, f)) ? 'implant bridge' : 'bridge';
    return `${type} ${teeth[0]}–${teeth.at(-1)}`;
  }
  const fdi = teeth[0]!;
  return `${fdi} ${isImplantTooth(doc, fdi) ? 'implant crown' : reducedUnit(doc, fdi) ? 'reduced crown' : 'crown'}`;
}

/** Every restoration of the case in arch order: each bridge once, then each tooth that is in no bridge. */
export function restorationsOf(doc: DesignDocument): Restoration[] {
  const bridged = new Set(doc.bridges.flatMap((b) => b.teeth));
  const firsts = archOrder([...doc.bridges.map((b) => b.teeth[0]!), ...doc.setup.teeth.map((t) => t.fdi).filter((f) => !bridged.has(f))]);
  return firsts.map((first) => {
    const bridge = doc.bridges.find((b) => b.teeth[0] === first);
    const kind = bridge ? 'bridge' : 'crown';
    const teeth = bridge ? [...bridge.teeth] : [first];
    return { kind, teeth, name: nameOf(doc, kind, teeth) };
  });
}

/** The case reference used in file names (as crownTool.export and bridgeTool.export name their files). */
export const fileRef = (doc: DesignDocument, sessionRef?: string): string => (doc.setup.patientRef || sessionRef || 'case').replace(/[^\w.-]+/g, '_');

const materialLabel = (doc: DesignDocument, fdi: number): string => {
  const m = doc.setup.teeth.find((t) => t.fdi === fdi)?.material;
  return m ? MATERIAL_LABEL[m] : 'Material';
};
const openOf = (items: readonly ReadinessItem[], prefix = ''): OpenCheck[] =>
  items.filter((i) => i.status !== 'pass').map((i) => ({ label: `${prefix}${i.label}`, detail: i.detail }));
const toothOf = (doc: DesignDocument, fdi: number): ToothDesign | undefined => doc.teeth.find((t) => t.fdi === fdi);
const missingScan = (fdi: number) => `Load the ${jawOf(fdi)} scan first.`;
/** Neighbour contacts that are checked: found in the frame, on a side without a connector (as BridgePanels' freeNeighbours). */
const freeNeighbours = (doc: DesignDocument, tooth: ToothDesign, frame?: { mesialContact?: unknown; distalContact?: unknown }) => {
  const connected = connectedSides(doc, tooth.fdi);
  const f = tooth.frame ?? frame;
  return { mesial: Boolean(f?.mesialContact) && !connected.includes('mesial'), distal: Boolean(f?.distalContact) && !connected.includes('distal') };
};

/** The Finalize step's ready-to-mill rows of one tooth or unit (an implant crown's position and channel rows included). */
function readinessOf(
  doc: DesignDocument,
  tooth: ToothDesign,
  input: Pick<Parameters<typeof millReadiness>[0], 'axis' | 'crown' | 'neighbours'>,
  implant: ImplantResultView | undefined,
): ReadinessItem[] {
  const isImplant = isImplantTooth(doc, tooth.fdi);
  return millReadiness({
    ...input,
    margin: tooth.margin?.points.map((m) => [m.p[0]!, m.p[1]!, m.p[2]!] as const),
    params: tooth.params,
    material: materialLabel(doc, tooth.fdi),
    adaptationStale: adaptationStale(tooth),
    needs: isImplant ? IMPLANT_NEEDS : readinessNeeds(unitKind(doc.setup, tooth.fdi)),
  }).concat(isImplant ? implantReadiness(tooth, implant) : []);
}

/**
 * A single crown designed from the document (as the display does: stored pose and active adaptation), as the single
 * export writes it: an implant crown with its screw channel, a reduced crown as its framework plus the overpress part
 * when its cutback asks for one. With the Finalize step's ready-to-mill rows.
 */
async function designCrown(doc: DesignDocument, fdi: number, ref: string, name: string): Promise<RestorationExport> {
  const base = `${ref}-${fdi}`;
  const r: RestorationExport = { kind: 'crown', name, teeth: [fdi], base, stls: [], open: [] };
  const tooth = toothOf(doc, fdi);
  if (!tooth?.crown) return { ...r, skipped: 'No crown proposed yet.' };
  const ctx = toothContextFor(fdi);
  if (!ctx) return { ...r, skipped: missingScan(fdi) };
  const request = crownRequest(ctx, true, 'none');
  if (!request) return { ...r, skipped: 'Set the tooth frame, the margin and the insertion axis first.' };
  try {
    const [result, axis] = await Promise.all([
      analysis.designCrownUnlatched({ ...request, ...(cutbackFor(doc, fdi)?.overpress ? { overpress: true } : {}) }),
      axisTool.measureTooth(fdi),
    ]);
    const neighbours = { mesial: Boolean(tooth.frame?.mesialContact), distal: Boolean(tooth.frame?.distalContact) };
    const framework = result.framework;
    const stls = framework
      ? [
          { file: `${base}-framework.stl`, bytes: frameworkStl({ positions: framework.positions, indices: result.indices }) },
          ...(framework.overpress ? [{ file: `${base}-overpress.stl`, bytes: overpressStl(framework.overpress) }] : []),
        ]
      : [{ file: `${base}.stl`, bytes: crownStl(result.implant?.cut ?? result) }];
    return {
      ...r,
      stls,
      info: {
        ...constructionInfo({ doc, tooth, appVersion: APP_VERSION, result }),
        ...frameworkSidecar({ units: [{ fdi, framework }], overpress: framework?.overpress ? [framework.overpress] : [] }),
      },
      open: openOf(readinessOf(doc, tooth, { axis, crown: result, neighbours }, result.implant)),
    };
  } catch (e) {
    return { ...r, skipped: `The crown could not be designed: ${errorText(e)}` };
  }
}

const gateDetail = (c: QaCheck): string =>
  c.value !== undefined ? `${c.value}${c.threshold !== undefined ? ` (limit ${c.threshold})` : ''}` : 'Failed';

/**
 * A bridge designed from the document and merged into one solid (designBridge with union: true), as the bridge export
 * writes it: the merged solid (the framework bridge when units are reduced) plus each overpress part. With the Finalize
 * step's rows per unit (connected sides have no contact row) and the failed bridge checks (connectors, the merged
 * solid, seating, pontic base).
 */
async function designBridge(doc: DesignDocument, teeth: number[], ref: string, name: string): Promise<RestorationExport> {
  const r: RestorationExport = { kind: 'bridge', name, teeth, base: `${ref}-${teeth[0]}-${teeth.at(-1)}-bridge`, stls: [], open: [] };
  if (!teeth.some((f) => toothOf(doc, f)?.crown)) return { ...r, skipped: 'The bridge has not been proposed yet.' };
  const ctx = toothContextFor(teeth[0]!);
  if (!ctx) return { ...r, skipped: missingScan(teeth[0]!) };
  try {
    const request = bridgeRequest(doc, teeth[0]!, { union: true });
    if (!request) return { ...r, skipped: 'Not a bridge any more.' };
    const abutments = teeth.filter((f) => unitKind(doc.setup, f) === 'abutment');
    const [result, axes] = await Promise.all([
      analysis.designBridgeUnlatched(request),
      Promise.all(abutments.map(async (f) => [f, await axisTool.measureTooth(f)] as const)),
    ]);
    const axisOf = new Map(axes);
    const open: OpenCheck[] = [];
    for (const fdi of teeth) {
      const tooth = toothOf(doc, fdi);
      const view = result.units.find((u) => u.fdi === fdi);
      if (!tooth) continue;
      const items = readinessOf(doc, tooth, { axis: axisOf.get(fdi) ?? null, crown: view ? unitStatus(view) : null, neighbours: freeNeighbours(doc, tooth, view?.frame) }, view?.implant);
      open.push(...openOf(items, `${fdi}: `));
    }
    open.push(...bridgeGate(result).filter((c) => !c.passed).map((c) => ({ label: c.message, detail: gateDetail(c) })));
    if (!result.union) return { ...r, open, skipped: `The units could not be merged into one solid: ${result.unionError ?? 'unknown reason'}` };
    // With reduced units the merged solid is the framework bridge (as bridgeTool.export names it).
    const base = `${ref}-${teeth[0]}-${teeth.at(-1)}-${result.units.some((u) => u.framework) ? 'framework' : 'bridge'}`;
    return {
      ...r,
      base,
      stls: [
        { file: `${base}.stl`, bytes: bridgeStl({ positions: result.union.positions, indices: result.union.indices }) },
        ...(result.overpress ?? []).map((o) => ({ file: `${ref}-${o.fdi}-overpress.stl`, bytes: overpressStl(o) })),
      ],
      info: { ...bridgeConstructionInfo({ doc, teeth, appVersion: APP_VERSION, result }), ...frameworkSidecar(result) },
      open,
    };
  } catch (e) {
    return { ...r, skipped: errorText(e) };
  }
}

export interface ExportAll {
  restorations: RestorationExport[];
  zip: { bytes: Uint8Array; fileName: string };
  /** Every restoration was designed and passes every check. */
  ready: boolean;
}

/**
 * Design every restoration of the document in the worker (not only the active tooth) and pack them into one zip with
 * a manifest of their readiness. One at a time, so the worker keeps answering the editor in between.
 */
export async function exportAll(doc: DesignDocument, sessionRef?: string): Promise<ExportAll> {
  const ref = fileRef(doc, sessionRef);
  const restorations: RestorationExport[] = [];
  for (const { kind, teeth, name } of restorationsOf(doc)) {
    restorations.push(kind === 'bridge' ? await designBridge(doc, teeth, ref, name) : await designCrown(doc, teeth[0]!, ref, name));
  }
  const zip = exportAllZip({ caseRef: ref, caseId: doc.caseId, patientRef: doc.setup.patientRef, appVersion: APP_VERSION, restorations });
  return { restorations, zip, ready: restorations.every((r) => !r.skipped && r.open.length === 0) };
}

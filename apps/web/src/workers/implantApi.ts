import * as Comlink from 'comlink';
import type { CrownDesign } from '../geometry/crown';
import {
  designImplantCrown,
  gingivalOpening,
  implantToothFrame,
  proposeScrewChannel,
  type GingivalOpening,
  type ImplantCrownDesign,
  type ImplantUnit,
} from '../geometry/implantCrown';
import { searchImplantPath } from '../geometry/implantBridge';
import {
  implantLibraryEntry,
  implantPoseFromPose,
  implantPoseToPose,
  placeAtImplantPose,
  type ImplantLibrary,
} from '../geometry/implantLibrary';
import type { RayCaster } from '../geometry/raycast';
import { registerScanBody } from '../geometry/scanBody';
import { syntheticImplantLibrary } from '../geometry/syntheticImplant';
import type {
  CrownRequest,
  CrownResult,
  ImplantEntryView,
  ImplantPathRequest,
  ImplantPathView,
  ImplantResultView,
  ImplantUnitRequest,
  ScanBodyRequest,
  ScanBodyResult,
  ScrewChannelProposal,
} from './analysisTypes';
import type { RetainedScan, ScanRegistry } from './scanRegistry';

/**
 * The geometry worker's implant calls (specs/2026-10-25-implant-bridges.md): the synthetic library (built once in the
 * worker; vendor libraries are not shipped), the scan-body match, implant crowns, the common path over implant axes
 * and the auto-angled screw channel. geometry.worker.ts spreads `api` into its own API and uses `unitOf`/`viewOf` for
 * the implant units of a bridge.
 */
export function createImplantApi(deps: { registry: ScanRegistry; rayOf: (scan: RetainedScan) => RayCaster; initBooleans: () => Promise<void> }) {
  const { registry, rayOf } = deps;
  let library: ImplantLibrary | null = null;
  const lib = () => (library ??= syntheticImplantLibrary());
  const entryOf = (key: string) => implantLibraryEntry(lib(), key);

  /** A stored implant unit with its library entry. */
  const unitOf = (req: ImplantUnitRequest): ImplantUnit => ({
    entry: entryOf(req.libraryId),
    pose: implantPoseFromPose(req.pose),
    ...(req.channel ? { channel: req.channel } : {}),
  });

  /** The gingival opening of a unit on a scan (cached per scan, entry and pose). */
  const openingOf = (scan: RetainedScan, unit: ImplantUnit): GingivalOpening =>
    registry.cached(scan, `opening:${unit.entry.key}:${JSON.stringify(unit.pose)}`, () => gingivalOpening({ positions: scan.positions, entry: unit.entry, pose: unit.pose }));

  /** A designed unit's implant extras for the main thread; the cut mesh buffers are copied into `transfer`. */
  const viewOf = (design: CrownDesign, transfer: ArrayBuffer[]): ImplantResultView | undefined => {
    const x = (design as Partial<ImplantCrownDesign>).implant;
    if (!x) return undefined;
    let cut: ImplantResultView['cut'];
    if (x.cut) {
      cut = { positions: x.cut.positions.slice(), indices: x.cut.indices.slice() };
      transfer.push(cut.positions.buffer as ArrayBuffer, cut.indices.buffer as ArrayBuffer);
    }
    return {
      libraryId: x.libraryId,
      engaging: x.engaging,
      channel: x.channel,
      tiBaseGap: x.tiBaseGap,
      rimUndercutCount: x.rimUndercutCount,
      opening: { centre: x.opening.centre, meanHeightMm: x.opening.meanHeightMm, coverage: x.opening.coverage },
      ...(cut ? { cut } : {}),
      ...(x.cutCheck ? { cutOk: x.cutCheck.ok } : {}),
    };
  };

  /** One implant crown for a single unit (no bridge), as designCrown does for a prep. */
  const design = (request: CrownRequest, cutChannel: boolean): ImplantCrownDesign => {
    if (!request.implant) throw new Error(`Tooth ${request.fdi} has no implant position`);
    const scan = registry.get(request.jawSha);
    const antagonist = request.antagonistSha && registry.has(request.antagonistSha) ? registry.get(request.antagonistSha) : null;
    const unit = unitOf(request.implant);
    return designImplantCrown({
      fdi: request.fdi,
      jaw: { positions: scan.positions, indices: scan.indices, ray: rayOf(scan) },
      antagonist: antagonist ? rayOf(antagonist) : undefined,
      frame: request.frame,
      implant: unit,
      axis: request.axis,
      params: request.params,
      pose: request.pose,
      maps: request.maps,
      adapt: request.adapt,
      opening: openingOf(scan, unit),
      cutChannel,
    });
  };

  const api = {
    /** The library entries (the synthetic generic library). */
    implantLibrary(): ImplantEntryView[] {
      return lib().entries.map((e) => ({
        key: e.key,
        libraryId: e.libraryId,
        system: e.system,
        platform: e.platform,
        engaging: e.engaging,
        channelDiameterMm: e.channelDiameterMm,
        ascMaxDeg: e.ascMaxDeg,
        maxDivergenceDeg: e.maxDivergenceDeg,
        bondingGapMm: e.bondingGapMm,
        scanBodyTopZ: e.scanBodyTopZ,
        scanBodyRadiusMm: e.scanBodyRadiusMm,
      }));
    },

    /** The implant position step: the library scan body matched to the scanned one from a click on its top. */
    registerScanBody(request: ScanBodyRequest): ScanBodyResult {
      const t0 = performance.now();
      const scan = registry.get(request.jawSha);
      const entry = entryOf(request.libraryId);
      const reg = registerScanBody({ positions: scan.positions, indices: scan.indices, click: request.click, entry });
      let opening: GingivalOpening | null = null;
      if (reg.passed) {
        try {
          opening = openingOf(scan, { entry, pose: reg.pose });
        } catch {
          opening = null;
        }
      }
      const frame = request.frame && opening ? implantToothFrame({ frame: request.frame, opening, ray: rayOf(scan) }) : undefined;
      const ghost = placeAtImplantPose(entry.scanBody, reg.pose);
      const result: ScanBodyResult = {
        pose: implantPoseToPose(reg.pose),
        origin: reg.pose.origin,
        axis: reg.pose.axis,
        rmsMm: reg.rmsMm,
        maxMm: reg.maxMm,
        inlierFraction: reg.inlierFraction,
        coverage: reg.coverage,
        passed: reg.passed,
        failures: reg.failures,
        ...(frame ? { frame } : {}),
        ...(opening ? { opening: { centre: opening.centre, meanHeightMm: opening.meanHeightMm, coverage: opening.coverage } } : {}),
        scanBody: { positions: ghost.positions, indices: entry.scanBody.indices.slice() },
        ms: performance.now() - t0,
      };
      return Comlink.transfer(result, [result.scanBody.positions.buffer as ArrayBuffer, result.scanBody.indices.buffer as ArrayBuffer]);
    },

    /** An implant crown (single unit): the restoration, its maps, the screw channel and the restoration with it. */
    async designImplantCrown(request: CrownRequest): Promise<CrownResult> {
      const t0 = performance.now();
      await deps.initBooleans();
      const d = design(request, true);
      const { mesh, implant: _extras, ...rest } = d;
      const transfer: ArrayBuffer[] = [mesh.positions.buffer as ArrayBuffer, mesh.indices.buffer as ArrayBuffer, d.moveWeights.buffer as ArrayBuffer];
      for (const m of Object.values(d.maps ?? {})) transfer.push((m as Float32Array).buffer as ArrayBuffer);
      const implant = viewOf(d, transfer);
      const result: CrownResult = { ...rest, positions: mesh.positions, indices: mesh.indices, ...(implant ? { implant } : {}), ms: performance.now() - t0 };
      return Comlink.transfer(result, transfer);
    },

    /** Bridge axis step: the common path over the implant axes, with the divergence against the library limit. */
    implantPath(request: ImplantPathRequest): ImplantPathView {
      return searchImplantPath(
        request.implants.map((i) => ({ fdi: i.fdi, axis: implantPoseFromPose(i.pose).axis, maxDivergenceDeg: entryOf(i.libraryId).maxDivergenceDeg })),
      );
    },

    /** classical.screw-channel: the straight channel if it passes, else the smallest ASC angle whose exit and walls pass. */
    async screwChannelAuto(request: CrownRequest): Promise<ScrewChannelProposal> {
      if (!request.implant) throw new Error(`Tooth ${request.fdi} has no implant position`);
      const d = design({ ...request, implant: { ...request.implant, channel: undefined } }, false);
      const found = proposeScrewChannel({ mesh: d.mesh, unit: unitOf(request.implant), fdi: request.fdi, frame: request.frame, wallMm: request.params.channelWallMm });
      return found ? { angleDeg: found.angleDeg, azimuthDeg: found.azimuthDeg, exitOk: found.report.exitOk, minWallMm: found.report.minWallMm } : null;
    },
  };

  return { api, unitOf, viewOf };
}

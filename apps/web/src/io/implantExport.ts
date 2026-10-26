import type { ToothDesign } from '@dcad/shared';
import type { ImplantResultView } from '../workers/analysisTypes';

/**
 * The implant part of a construction sidecar (specs/2026-10-25-implant-bridges.md, Export): what CAM and the lab need
 * to match the Ti-bases. The library entry, the implant pose (platform centre, implant axis, anti-rotation
 * direction, as a pose of the library frame), the screw channel axis and angle, and the fit quality. Null for a crown
 * on a prepared tooth.
 */
export function implantSidecar(tooth: Pick<ToothDesign, 'implant' | 'screwChannel'> | undefined, view: ImplantResultView | null | undefined) {
  const implant = tooth?.implant;
  if (!implant) return null;
  const c = view?.channel;
  return {
    libraryId: implant.libraryId,
    engaging: implant.engaging,
    /** The library frame (origin at the platform centre, +z the implant axis, +x the anti-rotation flat) in the scan. */
    implantPose: implant.scanBodyPose,
    fit: implant.fit,
    screwChannel: c
      ? {
          angleDeg: c.angleDeg,
          azimuthDeg: c.azimuthDeg,
          /** On the implant axis at the screw-head seat; the channel runs from it along `direction`. */
          pivot: c.pivot,
          direction: c.direction,
          diameterMm: c.radiusMm * 2,
          exit: c.exit ? { point: c.exit.point, occlusalDot: c.exit.occlusalDot, lingualDot: c.exit.lingualDot } : null,
          minWallMm: Number.isFinite(c.minWallMm) ? c.minWallMm : null,
          requiredWallMm: c.requiredWallMm,
          ok: c.exitOk && c.wallOk,
        }
      : (tooth?.screwChannel ?? null),
    tiBase: view
      ? {
          bondingGapMm: view.tiBaseGap.gapMm,
          gapMaxErrorMm: view.tiBaseGap.maxErrorMm,
          minGapMm: view.tiBaseGap.intaglioMinGapMm,
          seatable: view.rimUndercutCount === 0,
        }
      : null,
  };
}

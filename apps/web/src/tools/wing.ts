import type { CaseSetup, ToothFrame } from '@dcad/shared';

type V3 = [number, number, number];

/** The tooth is a Maryland wing in the case setup. */
export const isWing = (setup: Pick<CaseSetup, 'teeth'>, fdi: number): boolean => setup.teeth.find((t) => t.fdi === fdi)?.restoration === 'maryland-wing';

/**
 * Worker request fields for a Maryland wing: the frame origin (the click on the lingual surface, inside the outline)
 * seeds the region's flood fill, because a crescent-shaped outline may not contain the point straight down through
 * its centre (the crown's prep-top seed). Empty for other teeth, so it can be spread into any request.
 */
export function wingSeed(setup: Pick<CaseSetup, 'teeth'>, fdi: number, frame: Pick<ToothFrame, 'origin'> | undefined): { seed?: V3 } {
  if (!frame || !isWing(setup, fdi)) return {};
  return { seed: [frame.origin[0], frame.origin[1], frame.origin[2]] };
}

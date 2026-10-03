import { z } from 'zod';

/** All geometry is in millimetres. */
export const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof Vec3>;

/** Unit quaternion, [x, y, z, w]. */
export const Quat = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type Quat = z.infer<typeof Quat>;

export const Pose = z.object({
  position: Vec3,
  quaternion: Quat,
  scale: Vec3,
});
export type Pose = z.infer<typeof Pose>;

export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'sha256 hex digest');

/**
 * Content-addressed reference to a mesh. The hash identifies the bytes; the
 * fileId (when stored on the backend) says where to fetch them. Units and
 * frame are explicit so the same reference works for in-browser and
 * server-side (ML) proposers.
 */
export const MeshRef = z.object({
  sha256: Sha256,
  fileId: z.string().optional(),
  units: z.literal('mm'),
  /** Coordinate frame the vertices are expressed in. Scans keep their native frame. */
  frame: z.enum(['scan', 'tooth-local']),
  triangleCount: z.number().int().nonnegative().optional(),
});
export type MeshRef = z.infer<typeof MeshRef>;

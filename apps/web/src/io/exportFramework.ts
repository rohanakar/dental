import type { IndexedMesh } from '../geometry/mesh';
import { writeBinaryStl } from '../geometry/stl';
import type { FrameworkView, OverpressView } from '../workers/frameworkTypes';

/** Binary STL of a framework (a reduced crown, or a merged framework bridge), mm. */
export function frameworkStl(mesh: IndexedMesh): Uint8Array {
  return writeBinaryStl(mesh, 'dcad framework');
}

/** Binary STL of an overpress part (to press in wax over the framework), mm. */
export function overpressStl(part: Pick<OverpressView, 'positions' | 'indices'>): Uint8Array {
  return writeBinaryStl({ positions: part.positions, indices: part.indices }, 'dcad overpress');
}

/**
 * The framework section of a construction sidecar: per reduced unit its cutback, the measured veneer space, the
 * shortfall ("insufficient veneering space") and the framework's validation; per overpress part its validation.
 */
export function frameworkSidecar(units: ReadonlyArray<{ fdi: number; framework?: FrameworkView }>, overpress: readonly OverpressView[] = []) {
  return {
    framework: {
      units: units.flatMap((u) =>
        u.framework
          ? [
              {
                fdi: u.fdi,
                cutback: u.framework.cutback,
                veneer: u.framework.stats,
                shortfall: u.framework.shortfall ?? null,
                protection: u.framework.protection ?? null,
                validation: u.framework.validation,
                warnings: u.framework.warnings,
              },
            ]
          : [],
      ),
      overpress: overpress.map((o) => ({ fdi: o.fdi, validation: o.validation, volumeMm3: o.volumeMm3, components: o.components, dropped: o.dropped })),
    },
  };
}

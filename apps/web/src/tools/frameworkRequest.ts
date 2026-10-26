import type { DesignDocument } from '@dcad/shared';
import { cutbackFor } from '../design/framework';
import { frameworkSidecar as sidecar } from '../io/exportFramework';
import type { FrameworkView, OverpressView } from '../workers/frameworkTypes';

/** The framework fields of a worker unit request: the cutback of a reduced unit, nothing for an anatomic one. */
export function frameworkFields(doc: DesignDocument, fdi: number): { cutback?: NonNullable<ReturnType<typeof cutbackFor>> } {
  const cutback = cutbackFor(doc, fdi);
  return cutback ? { cutback } : {};
}

/** The framework section of a bridge's construction sidecar, or nothing when no unit is reduced. */
export function frameworkSidecar(result: { units: ReadonlyArray<{ fdi: number; framework?: FrameworkView }>; overpress?: readonly OverpressView[] }) {
  return result.units.some((u) => u.framework) ? sidecar(result.units, result.overpress) : {};
}

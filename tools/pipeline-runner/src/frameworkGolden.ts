import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CUTBACK_DEFAULTS, withReduced } from '@dcad/shared';
import { GoldenCase, type GoldenCaseInput, writeSyntheticBridgeCase } from './golden';

/** The framework variant of the posterior synthetic bridge: 35–[36]–37 as a CoCr framework with overpress. */
export const SYNTHETIC_FRAMEWORK_ID = 'synthetic-framework-35-37';

/**
 * Write the framework variant of the posterior synthetic bridge (no patient data) into `dir`: the same scans and
 * clicks as synthetic-bridge-35-37, with reduced units (reduced crowns and a reduced pontic), CoCr, and the default
 * cutback with overpress.
 */
export function writeSyntheticFrameworkCase(dir: string, options: { along?: number; across?: number } = {}): GoldenCase {
  writeSyntheticBridgeCase(dir, 'posterior', options);
  const base = JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8')) as GoldenCaseInput;
  const spec: GoldenCaseInput = {
    ...base,
    id: SYNTHETIC_FRAMEWORK_ID,
    material: 'cocr',
    bridge: {
      ...base.bridge!,
      units: base.bridge!.units.map((u) => ({ ...u, restoration: withReduced(u.restoration, true) })),
      cutback: { ...CUTBACK_DEFAULTS, overpress: true },
    },
  };
  writeFileSync(join(dir, 'case.json'), `${JSON.stringify(spec, null, 2)}\n`);
  return GoldenCase.parse(spec);
}

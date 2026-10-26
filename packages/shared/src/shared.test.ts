import { describe, expect, it } from 'vitest';
import { bridgesOf, commandFromToolCall, type Material, type RestorationType, type ToothOrder, validateBridges } from './index';

const unit = (fdi: number, restoration: RestorationType = 'anatomic-crown', material: Material = 'zirconia'): ToothOrder => ({
  fdi,
  restoration,
  material,
});
const chain = (fdis: number[]): [number, number][] => fdis.slice(1).map((b, i) => [fdis[i]!, b]);
const validate = (teeth: ToothOrder[], connections: [number, number][]) => validateBridges({ teeth, connections });
const errorCodes = (teeth: ToothOrder[], connections: [number, number][]) => validate(teeth, connections).errors.map((e) => e.code);

describe('shared schemas', () => {
  it('validates bridge setups', () => {
    // Valid: a cantilever, a midline bridge with two cantilever pontics, a full lower arch.
    expect(validate([unit(13), unit(12, 'pontic')], [[12, 13]])).toEqual({ errors: [], warnings: [] });
    const midline = [unit(12, 'pontic'), unit(11), unit(21), unit(22, 'pontic')];
    expect(validate(midline, chain([12, 11, 21, 22]))).toEqual({ errors: [], warnings: [] });
    expect(bridgesOf({ teeth: midline, connections: [[21, 22], [11, 12], [11, 21]] })).toEqual([[12, 11, 21, 22]]);
    const lowerArch = [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38];
    const fullArch = lowerArch.map((fdi, i) => unit(fdi, i % 2 ? 'anatomic-crown' : 'pontic'));
    expect(validate(fullArch, chain(lowerArch)).errors).toEqual([]);

    // Errors.
    expect(errorCodes([unit(35), unit(37)], [[35, 37]])).toEqual(['not-adjacent']);
    expect(errorCodes([unit(35), unit(36, 'anatomic-crown', 'lithium-disilicate')], [[35, 36]])).toEqual(['mixed-materials']);
    expect(errorCodes([unit(35, 'pontic'), unit(36, 'pontic')], [[35, 36]])).toEqual(['no-abutment']);
    expect(errorCodes([unit(35), unit(36, 'pontic')], [])).toEqual(['unconnected-pontic']);
    // Maryland wings connect to pontics (a cantilever is valid), never to crowns.
    expect(validate([unit(11, 'maryland-wing'), unit(12, 'pontic')], [[11, 12]]).errors).toEqual([]);
    expect(errorCodes([unit(11, 'maryland-wing'), unit(21)], [[11, 21]])).toEqual(['connector-not-permitted']);
    // Inlays and onlays are retainers next to a pontic, never connected to a crown.
    expect(validate([unit(35, 'inlay'), unit(36, 'pontic'), unit(37, 'onlay')], chain([35, 36, 37])).errors).toEqual([]);
    expect(errorCodes([unit(35, 'inlay'), unit(36)], [[35, 36]])).toEqual(['connector-not-permitted']);

    // Warning only: lithium disilicate past 3 units.
    const ld = midline.map((t) => ({ ...t, material: 'lithium-disilicate' as const }));
    const result = validate(ld, chain([12, 11, 21, 22]));
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toEqual(['indication-units']);
  });

  it('maps tool calls back to validated commands', () => {
    expect(commandFromToolCall('move_crown', { fdi: 36, direction: 'occlusal', mm: 0.2 })).toEqual({
      type: 'moveCrown',
      fdi: 36,
      direction: 'occlusal',
      mm: 0.2,
    });
    expect(commandFromToolCall('unknown_tool', {})).toBeNull();
    expect(() => commandFromToolCall('move_crown', { fdi: 36, direction: 'up', mm: 0.2 })).toThrow();
  });
});

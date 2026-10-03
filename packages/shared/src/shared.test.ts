import { describe, expect, it } from 'vitest';
import {
  agentToolDefs,
  Command,
  commandFromToolCall,
  DesignParams,
  downstreamSteps,
  MATERIAL_PRESETS,
  ProposerId,
} from './index';

describe('shared schemas', () => {
  it('material presets satisfy DesignParams', () => {
    for (const preset of Object.values(MATERIAL_PRESETS)) {
      expect(() => DesignParams.parse(preset)).not.toThrow();
    }
  });

  it('rejects invalid FDI numbers', () => {
    expect(Command.safeParse({ type: 'moveCrown', fdi: 19, direction: 'mesial', mm: 0.1 }).success).toBe(false);
    expect(Command.safeParse({ type: 'moveCrown', fdi: 36, direction: 'mesial', mm: 0.1 }).success).toBe(true);
  });

  it('generates agent tool definitions with JSON Schema inputs', () => {
    const defs = agentToolDefs();
    const names = defs.map((d) => d.name);
    expect(names).toContain('move_crown');
    expect(names).toContain('adapt_occlusion');
    expect(names).toContain('get_design_metrics');
    const move = defs.find((d) => d.name === 'move_crown')!;
    expect(move.description).toMatch(/Translate/);
    expect(move.inputSchema.type).toBe('object');
    const props = move.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(['direction', 'fdi', 'mm']);
    expect(move.inputSchema).not.toHaveProperty('$schema');
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

  it('validates proposer ids', () => {
    expect(ProposerId.safeParse('classical.livewire-margin@1').success).toBe(true);
    expect(ProposerId.safeParse('ml.margin-unet@0.3.1').success).toBe(true);
    expect(ProposerId.safeParse('margin').success).toBe(false);
  });

  it('invalidates downstream steps', () => {
    expect(downstreamSteps('margin')).toEqual(['axis', 'params', 'proposal', 'adapt', 'finalize']);
  });
});

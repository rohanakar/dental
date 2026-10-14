import { describe, expect, it } from 'vitest';
import { commandFromToolCall } from './index';

describe('shared schemas', () => {
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

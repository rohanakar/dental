import { describe, expect, it } from 'vitest';
import { normalizeBase } from '../../vite.config';
import { assignRoles, roleFromFileName } from './files';

const file = (name: string) => ({ name }) as File;

describe('file roles', () => {
  it('detects roles from common export names', () => {
    expect(roleFromFileName('Case12_UpperJaw.stl')).toBe('upper');
    expect(roleFromFileName('mandibular.ply')).toBe('lower');
    expect(roleFromFileName('PreOp.stl')).toBe('preop');
    expect(roleFromFileName('scan.stl')).toBeNull();
  });

  it('assigns unnamed files to the preferred role, then the other jaw', () => {
    const out = assignRoles([file('a.stl'), file('b.stl')], 'upper');
    expect(out.map((o) => o.role)).toEqual(['upper', 'lower']);
    const named = assignRoles([file('x.stl'), file('lower.stl')], 'lower');
    expect(named.map((o) => [o.file.name, o.role])).toEqual([
      ['lower.stl', 'lower'],
      ['x.stl', 'upper'],
    ]);
  });
});

describe('base path', () => {
  it('normalizes VITE_BASE_PATH', () => {
    expect(normalizeBase(undefined)).toBe('/');
    expect(normalizeBase('')).toBe('/');
    expect(normalizeBase('/')).toBe('/');
    expect(normalizeBase('dental')).toBe('/dental/');
    expect(normalizeBase('/dental')).toBe('/dental/');
    expect(normalizeBase('/a/b/')).toBe('/a/b/');
  });
});

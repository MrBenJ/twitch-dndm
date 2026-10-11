import { describe, expect, it } from 'vitest';
import { formatIssue, Rejection, ValidationError } from '../src/errors';
import { fullId, localOf, packOf, refKey, splitId } from '../src/ids';

describe('ids', () => {
  it('splits prefixed and bare IDs', () => {
    expect(splitId('tp:club')).toEqual({ pack: 'tp', id: 'club' });
    expect(splitId('club')).toEqual({ pack: null, id: 'club' });
  });
  it('builds and takes apart full IDs', () => {
    expect(fullId('tp', 'club')).toBe('tp:club');
    expect(packOf('tp:club')).toBe('tp');
    expect(localOf('tp:club')).toBe('club');
    expect(refKey('ability', 'tp:club')).toBe('ability tp:club');
  });
});

describe('errors', () => {
  it('formats issues with location', () => {
    expect(formatIssue({ level: 'error', pack: 'tp', file: 'a.yaml', doc: 2, path: 'steps[0]', message: 'Unknown effect' }))
      .toBe('error: [tp] a.yaml#2 steps[0]: Unknown effect');
    expect(formatIssue({ level: 'warning', pack: 'channel', path: '', message: 'Dormant' }))
      .toBe('warning: [channel] Dormant');
  });
  it('ValidationError lists every issue', () => {
    const e = new ValidationError([
      { level: 'error', pack: 'a', path: 'x', message: 'one' },
      { level: 'error', pack: 'b', path: 'y', message: 'two' },
    ]);
    expect(e.message).toContain('one');
    expect(e.message).toContain('two');
    expect(e.issues).toHaveLength(2);
  });
  it('Rejection carries a code', () => {
    expect(new Rejection('Nope').code).toBe('rejected');
    expect(new Rejection('Cooling', 'on-cooldown').code).toBe('on-cooldown');
  });
});

import { describe, expect, it } from 'vitest';
import { harness } from './helpers/harness';

describe('adventures', () => {
  it('lines up nodes and waits for go; branches by outcome', () => {
    const h = harness();
    h.open(); h.join('al');
    expect(h.fail({ type: 'go' }).code).toBe('no-adventure');
    h.do({ type: 'startAdventure', adventure: 'tp:trip' });
    expect(h.game.session!.adventure).toEqual({ id: 'tp:trip', lined: 'intro' });
    expect(h.fail({ type: 'startAdventure', adventure: 'tp:trip' }).code).toBe('adventure-running');
    h.do({ type: 'go' });
    expect(h.fail({ type: 'go' }).code).toBe('busy');
    h.do({ type: 'endEncounter' });
    expect(h.game.session!.adventure!.lined).toBe('pick');
    h.do({ type: 'go' });
    h.do({ type: 'respond', character: 'al', input: { choice: 'b' } });
    h.wait(30000);
    expect(h.game.session!.adventure!.lined).toBe('talk');
    h.do({ type: 'go' });
    expect(h.game.session!.encounter).toMatchObject({ kind: 'tp:show', params: { text: 'Hello there' } });
    h.wait(10000);
    h.do({ type: 'go' });
    h.do({ type: 'endEncounter' });
    expect(h.game.session!.adventure).toBeNull();
    expect(h.types()).toContain('core:adventure-finished');
  });

  it('uses default when the outcome has no entry, and skipTo / stop work', () => {
    const h = harness();
    h.open(); h.join('al');
    h.do({ type: 'startAdventure', adventure: 'tp:trip' });
    expect(h.fail({ type: 'skipTo', node: 'nope' }).code).toBe('unknown-node');
    h.do({ type: 'skipTo', node: 'fight' });
    h.do({ type: 'go' });
    h.do({ type: 'endEncounter', outcome: 'ended' });
    expect(h.game.session!.adventure!.lined).toBe('end');
    h.do({ type: 'stopAdventure' });
    expect(h.game.session!.adventure).toBeNull();
    expect(h.fail({ type: 'stopAdventure' }).code).toBe('no-adventure');
  });

  it('hand-started encounters do not move the adventure', () => {
    const h = harness();
    h.open(); h.join('al');
    h.do({ type: 'startAdventure', adventure: 'tp:trip' });
    h.spawn();
    h.do({ type: 'endEncounter' });
    expect(h.game.session!.adventure!.lined).toBe('intro');
  });
});

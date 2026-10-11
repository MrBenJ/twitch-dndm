import { describe, expect, it } from 'vitest';
import { starterHarness } from './helpers';

async function party() {
  const h = await starterHarness({ seed: 3 });
  h.open();
  h.join('fi', 'starter:sword'); h.join('ta', 'starter:shield'); h.join('he', 'starter:staff');
  h.do({ type: 'startAdventure', adventure: 'starter:the-cave' });
  h.do({ type: 'go' });          // entrance story
  h.wait(10000);
  h.do({ type: 'go' });          // fork vote
  return h;
}

function lined(h: Awaited<ReturnType<typeof party>>) {
  return h.game.session!.adventure?.lined ?? null;
}

describe('the-cave', () => {
  it('left branch: story, vote, fight won, trap, treasure', async () => {
    const h = await party();
    for (const id of ['fi', 'ta', 'he']) h.do({ type: 'respond', character: id, input: { choice: 'left' } });
    h.wait(30000);
    expect(lined(h)).toBe('goblin-fight');
    h.do({ type: 'go' });
    for (const id of ['fi', 'ta', 'he']) h.use(id, 'starter:attack');
    h.do({ type: 'endEncounter', outcome: 'won' });
    expect(lined(h)).toBe('trap');
    h.do({ type: 'go' });
    for (const id of ['fi', 'ta']) h.do({ type: 'respond', character: id, input: {} });
    h.wait(20000);
    expect(lined(h)).toBe('treasure');
    h.do({ type: 'go' });
    for (const id of ['fi', 'ta', 'he']) h.do({ type: 'respond', character: id, input: {} });
    h.wait(30000);
    expect(h.game.session!.adventure).toBeNull();
    expect(h.types()).toContain('core:adventure-finished');
    expect(h.char('fi').gold).toBeGreaterThanOrEqual(25 + 25);
    h.do({ type: 'closeSession' });
  });

  it('right branch: story, vote, shop purchase, trap, treasure', async () => {
    const h = await party();
    for (const id of ['fi', 'ta', 'he']) h.do({ type: 'respond', character: id, input: { choice: 'right' } });
    h.wait(30000);
    expect(lined(h)).toBe('merchant');
    h.do({ type: 'go' });
    h.do({ type: 'giveGold', target: 'fi', amount: 15 });
    h.do({ type: 'respond', character: 'fi', input: { buy: 'starter:health-potion' } });
    expect(h.char('fi').inventory).toEqual({ 'starter:health-potion': 1 });
    h.do({ type: 'endEncounter' });
    expect(lined(h)).toBe('trap');
    h.do({ type: 'go' });
    h.wait(20000);
    expect(h.char('he').hp).toBe(75);
    h.do({ type: 'go' });
    h.do({ type: 'respond', character: 'he', input: {} });
    h.wait(30000);
    expect(h.char('he').hp).toBe(90);
    expect(h.game.session!.adventure).toBeNull();
    h.do({ type: 'closeSession' });
  });

  it('ending the fight without a win goes to rest', async () => {
    const h = await party();
    h.do({ type: 'respond', character: 'fi', input: { choice: 'left' } });
    h.wait(30000);
    h.do({ type: 'go' });
    h.do({ type: 'endEncounter' });
    expect(lined(h)).toBe('rest');
  });
});

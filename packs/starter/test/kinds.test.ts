import { describe, expect, it } from 'vitest';
import { starterHarness } from './helpers';

const start = (encounter: Record<string, unknown>) => ({ type: 'startEncounter' as const, encounter });

describe('story', () => {
  it('shows text and ends after show-for, or when the streamer ends it', async () => {
    const h = await starterHarness();
    h.open(); h.join('al');
    h.do(start({ 'starter:story': { title: 'Hi', text: 'Once upon a time', 'show-for': '5s' } }));
    expect(h.view('al').panel).toEqual({ type: 'story-card', title: 'Hi', text: 'Once upon a time' });
    expect(h.view(null).overlay).toMatchObject({ title: 'Hi', text: 'Once upon a time', 'closes-at': 5000 });
    expect(h.fail({ type: 'respond', character: 'al', input: {} }).code).toBe('rejected');
    h.wait(5000);
    expect(h.log.at(-1)!.data).toMatchObject({ outcome: 'done' });
    h.do(start({ 'starter:story': { text: 'Waits for the streamer' } }));
    h.wait(600000);
    expect(h.game.session!.encounter).not.toBeNull();
    h.do({ type: 'endEncounter' });
  });
});

describe('vote', () => {
  const vote = { 'starter:vote': { prompt: 'Which way?', choices: { left: 'Left', right: 'Right' }, time: '30s' } };

  it('counts votes, lets members change their vote, picks the most voted', async () => {
    const h = await starterHarness();
    h.open(); h.join('a1'); h.join('a2'); h.join('a3');
    h.do(start(vote));
    h.do({ type: 'respond', character: 'a1', input: { choice: 'left' } });
    h.do({ type: 'respond', character: 'a2', input: { choice: 'left' } });
    h.do({ type: 'respond', character: 'a3', input: { choice: 'right' } });
    h.do({ type: 'respond', character: 'a2', input: { choice: 'right' } });
    expect(h.view('a2').panel).toMatchObject({ type: 'choices', selected: 'right', prompt: 'Which way?' });
    expect(h.view(null).overlay).toMatchObject({ tallies: [{ label: 'Left', count: 1 }, { label: 'Right', count: 2 }] });
    expect(h.fail({ type: 'respond', character: 'a1', input: { choice: 'up' } }).message).toBe("That isn't one of the choices");
    h.wait(30000);
    expect(h.log.at(-1)!.data).toMatchObject({ outcome: 'right' });
  });

  it('a vote with no votes is a tie among all choices; tie-break first picks the first', async () => {
    const h = await starterHarness();
    h.open(); h.join('a1');
    h.do(start({ 'starter:vote': { prompt: 'P', choices: { x: 'X', y: 'Y' }, time: '5s', 'tie-break': 'first' } }));
    h.wait(5000);
    expect(h.log.at(-1)!.data).toMatchObject({ outcome: 'x' });
  });

  it('random tie-break always picks one of the tied choices', async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const h = await starterHarness({ seed });
      h.open();
      h.do(start(vote));
      h.wait(30000);
      expect(['left', 'right']).toContain(h.log.at(-1)!.data.outcome);
    }
  });

  it('the streamer ending a vote early takes the current leader', async () => {
    const h = await starterHarness();
    h.open(); h.join('a1');
    h.do(start(vote));
    h.do({ type: 'respond', character: 'a1', input: { choice: 'right' } });
    h.do({ type: 'endEncounter' });
    expect(h.log.at(-1)!.data).toMatchObject({ outcome: 'right' });
  });
});

describe('treasure', () => {
  it('pays and heals those who claimed, once each; knocked-out claimants get no heal', async () => {
    const h = await starterHarness();
    h.open(); h.join('a1'); h.join('a2'); h.join('a3');
    h.do({ type: 'knockOut', character: 'a1' });
    h.do({ type: 'revivePlayer', character: 'a1' });
    h.do({ type: 'knockOut', character: 'a2' });
    h.do(start({ 'starter:treasure': { gold: 10, xp: 5, items: ['starter:health-potion'], heal: '50%', time: '20s' } }));
    h.do({ type: 'respond', character: 'a1', input: {} });
    h.do({ type: 'respond', character: 'a2', input: {} });
    expect(h.fail({ type: 'respond', character: 'a1', input: {} }).message).toBe("You've already claimed this");
    expect(h.view('a1').panel).toMatchObject({ type: 'tap-button', label: 'Claim', tapped: true });
    h.wait(20000);
    expect(h.char('a1')).toMatchObject({ gold: 10, xp: 5, hp: 75, inventory: { 'starter:health-potion': 1 } });
    expect(h.char('a2')).toMatchObject({ gold: 10, hp: 0 });
    expect(h.char('a3').gold).toBe(0);
  });

  it('pays claimants when the streamer ends it early, not when the session closes', async () => {
    const h = await starterHarness();
    h.open(); h.join('a1');
    h.do(start({ 'starter:treasure': { gold: 10, time: '20s' } }));
    h.do({ type: 'respond', character: 'a1', input: {} });
    h.do({ type: 'endEncounter' });
    expect(h.char('a1').gold).toBe(10);
    h.do(start({ 'starter:treasure': { gold: 10, time: '20s' } }));
    h.do({ type: 'respond', character: 'a1', input: {} });
    h.do({ type: 'closeSession' });
    expect(h.char('a1').gold).toBe(10);
  });
});

describe('trap', () => {
  const tapTrap = { 'starter:trap': { prompt: 'Dodge!', time: '10s', taps: '50%', penalty: { target: 'non-responders', steps: [{ 'starter:damage': { power: 15 } }] } } };

  it('is disarmed when enough members tap', async () => {
    const h = await starterHarness();
    h.open(); h.join('a1'); h.join('a2');
    h.do(start(tapTrap));
    h.do({ type: 'respond', character: 'a1', input: {} });
    expect(h.fail({ type: 'respond', character: 'a1', input: {} }).message).toBe('Already tapped');
    h.wait(10000);
    expect(h.log.at(-1)!.data).toMatchObject({ outcome: 'disarmed' });
    expect(h.char('a2').hp).toBe(100);
  });

  it('when triggered, hurts only those who did not respond', async () => {
    const h = await starterHarness();
    h.open(); h.join('a1'); h.join('a2'); h.join('a3');
    h.do(start(tapTrap));
    h.do({ type: 'respond', character: 'a1', input: {} });
    h.wait(10000);
    expect(h.log.find((e) => e.type === 'core:encounter-ended')!.data).toMatchObject({ outcome: 'triggered' });
    expect([h.char('a1').hp, h.char('a2').hp, h.char('a3').hp]).toEqual([100, 85, 85]);
  });

  it('answer mode: the most voted choice must be the answer; penalty target all', async () => {
    const h = await starterHarness();
    h.open(); h.join('a1'); h.join('a2');
    h.do(start({ 'starter:trap': {
      prompt: 'Which lever?', time: '10s', answer: 'red', choices: { red: 'Red', blue: 'Blue' },
      penalty: { target: 'all', steps: [{ 'starter:damage': { power: 10 } }] },
    } }));
    h.do({ type: 'respond', character: 'a1', input: { choice: 'blue' } });
    h.wait(10000);
    expect([h.char('a1').hp, h.char('a2').hp]).toEqual([90, 90]);
  });

  it('the streamer ending a trap counts as disarmed', async () => {
    const h = await starterHarness();
    h.open(); h.join('a1');
    h.do(start(tapTrap));
    h.do({ type: 'endEncounter' });
    expect(h.char('a1').hp).toBe(100);
  });

  it('rejects a trap with both or neither mode, or a missing answer', async () => {
    const h = await starterHarness();
    h.open();
    const bad = (params: Record<string, unknown>) => h.fail(start({ 'starter:trap': { prompt: 'P', time: '5s', penalty: { target: 'all', steps: [] }, ...params } }));
    expect(bad({}).message).toMatch(/needs either taps or answer \+ choices/);
    expect(bad({ taps: '50%', answer: 'x', choices: { x: 'X' } }).message).toMatch(/needs either/);
    expect(bad({ answer: 'z', choices: { x: 'X' } }).message).toMatch(/answer must be one of the choices/);
  });
});

describe('shop', () => {
  const shop = { 'starter:shop': { stock: [{ item: 'starter:health-potion', price: 15 }, { item: 'starter:sword', price: 1 }], time: '1m' } };

  it('sells for gold, with exact gold working and one short refused', async () => {
    const h = await starterHarness();
    h.open(); h.join('a1');
    h.do({ type: 'giveGold', target: 'a1', amount: 15 });
    h.do(start(shop));
    h.do({ type: 'respond', character: 'a1', input: { buy: 'starter:health-potion' } });
    expect(h.char('a1')).toMatchObject({ gold: 0, inventory: { 'starter:health-potion': 1 } });
    expect(h.types()).toContain('starter:purchased');
    const before = structuredClone(h.char('a1'));
    expect(h.fail({ type: 'respond', character: 'a1', input: { buy: 'starter:health-potion' } }).message).toBe('Not enough gold');
    expect(h.char('a1')).toEqual(before);
    expect(h.fail({ type: 'respond', character: 'a1', input: { buy: 'starter:sword' } }).message).toBe('You already have that');
    expect(h.fail({ type: 'respond', character: 'a1', input: { buy: 'starter:staff' } }).message).toBe("That isn't for sale here");
    expect(h.view('a1').panel).toMatchObject({ type: 'shop-list', gold: 0, entries: [{ item: 'starter:health-potion', price: 15, affordable: false }, expect.anything()] });
    h.wait(60000);
    expect(h.log.at(-1)!.data).toMatchObject({ outcome: 'closed' });
  });

  it('a secret shop has no overlay and only serves members present when it opened', async () => {
    const h = await starterHarness();
    h.open(); h.join('a1');
    h.do(start({ 'starter:shop': { ...shop['starter:shop'], secret: true } }));
    h.join('a2');
    h.do({ type: 'giveGold', target: 'party', amount: 50 });
    expect(h.view(null).overlay).toBeNull();
    expect(h.view('a2').panel).toEqual({ type: 'none' });
    expect(h.fail({ type: 'respond', character: 'a2', input: { buy: 'starter:health-potion' } }).message).toBe("This shop isn't open to you");
    h.do({ type: 'respond', character: 'a1', input: { buy: 'starter:health-potion' } });
  });
});

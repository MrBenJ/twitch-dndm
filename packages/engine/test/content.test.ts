import { describe, expect, it } from 'vitest';
import { detectDocType, DOC_SCHEMAS } from '../src/content';

describe('detectDocType', () => {
  it('finds the single type key', () => {
    expect(detectDocType({ class: 'brute', name: 'Brute' })).toEqual({ type: 'class', id: 'brute' });
    expect(detectDocType({ encounter: 'pile', ballot: {} })).toEqual({ type: 'encounter', id: 'pile' });
  });
  it('rejects no type, two types, bad IDs and non-objects', () => {
    expect(detectDocType({ name: 'x' })).toEqual({ error: expect.stringMatching(/no type key/) });
    expect(detectDocType({ name: 'x', class: 'a' })).toEqual({ error: expect.stringMatching(/Start the document with its type key \(found 'class' later\)/) });
    expect(detectDocType({ item: 'club', name: 'Club', slot: 'hand' })).toEqual({ type: 'item', id: 'club' });
    expect(detectDocType({ class: 'Bad Id' })).toEqual({ error: expect.stringMatching(/Invalid ID 'Bad Id'/) });
    expect(detectDocType({ class: 'tp:brute' })).toEqual({ error: expect.stringMatching(/without a pack prefix/) });
    expect(detectDocType('x')).toEqual({ error: expect.stringMatching(/must be a map/) });
  });
});

describe('DOC_SCHEMAS', () => {
  it('applies defaults', () => {
    const cls = DOC_SCHEMAS.class.parse({ class: 'brute', name: 'Brute' });
    expect(cls).toMatchObject({ tags: [], stats: {}, abilities: [], passives: [] });
    const item = DOC_SCHEMAS.item.parse({ item: 'club', name: 'Club' });
    expect(item).toMatchObject({ uses: 1, price: 0, stats: {}, abilities: [], passives: [] });
    const ab = DOC_SCHEMAS.ability.parse({ ability: 'poke', name: 'Poke', cooldown: '5s', target: 'foe', steps: [] });
    expect(ab).toMatchObject({ when: 'fight' });
  });
  it('rejects unknown fields and wrong types', () => {
    expect(DOC_SCHEMAS.stat.safeParse({ stat: 'power', name: 'Power', default: 'five' }).success).toBe(false);
    expect(DOC_SCHEMAS.slot.safeParse({ slot: 'hand', name: 'Hand', colour: 'red' }).success).toBe(false);
    expect(DOC_SCHEMAS.monster.safeParse({ monster: 'blob', name: 'Blob', hp: 10, abilities: [], behavior: { pile: {} } }).success).toBe(false);
  });
  it('lets encounter and adventure nodes carry a kind key', () => {
    expect(DOC_SCHEMAS.encounter.safeParse({ encounter: 'e', show: { text: 'hi' } }).success).toBe(true);
    expect(DOC_SCHEMAS.adventure.safeParse({
      adventure: 'a', name: 'A', start: 'n1', nodes: { n1: { show: { text: 'x' }, next: 'n2' }, n2: { use: 'e' } },
    }).success).toBe(true);
  });
});

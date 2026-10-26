import { describe, expect, it } from 'vitest';
import { charRef } from '../src/entities';
import { applyStatus } from '../src/ops';
import { Runtime } from '../src/runtime';
import { view } from '../src/view';
import { harness } from './helpers/harness';

describe('party view entries', () => {
  it('party entries carry level and statuses (spec 2b §5.2)', () => {
    const h = harness({ plugins: (api) => api.status('dozy', { name: 'Dozy' }) });
    h.open(); h.join('al');
    const rt = new Runtime(h.engine.registry, h.game);
    rt.now = 0;
    applyStatus(rt, charRef('al'), 'tp:dozy', 10000, {}, null);
    const v = view(rt, null);
    expect(v.party[0]).toMatchObject({ id: 'al', level: 1, statuses: [{ status: 'tp:dozy', until: expect.any(Number) }] });
    expect(v.party[0]!.statuses).toEqual(view(rt, 'al').character!.statuses);
  });
});

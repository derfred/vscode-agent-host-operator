import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matches } from '../src/selector.ts';

describe('matches', () => {
  const labels = { trust: 'personal', 'agenthost.derfred.com/host-set': 'bugzoo' };
  const cases: Array<[string, Parameters<typeof matches>[0], boolean]> = [
    ['an absent selector matches everything', undefined, true],
    ['{} matches everything', {}, true],
    ['matchLabels hit', { matchLabels: { trust: 'personal' } }, true],
    ['matchLabels miss', { matchLabels: { trust: 'client' } }, false],
    ['In', { matchExpressions: [{ key: 'trust', operator: 'In', values: ['client', 'personal'] }] }, true],
    ['NotIn on a set name', { matchExpressions: [{ key: 'agenthost.derfred.com/host-set', operator: 'NotIn', values: ['bugzoo'] }] }, false],
    ['NotIn on an absent label', { matchExpressions: [{ key: 'tier', operator: 'NotIn', values: ['x'] }] }, true],
    ['Exists', { matchExpressions: [{ key: 'trust', operator: 'Exists' }] }, true],
    ['DoesNotExist', { matchExpressions: [{ key: 'trust', operator: 'DoesNotExist' }] }, false],
    ['all terms ANDed', { matchLabels: { trust: 'personal' }, matchExpressions: [{ key: 'tier', operator: 'Exists' }] }, false],
  ];
  for (const [name, selector, expected] of cases) {
    it(name, () => assert.equal(matches(selector, labels), expected));
  }
});

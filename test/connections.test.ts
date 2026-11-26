import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentHost } from '../src/ahp.ts';
import { Connections, MIN_BACKOFF_MS } from '../src/connections.ts';

const fakeHost = (state = { alive: true, closed: 0 }) =>
  ({
    alive: () => state.alive,
    ping: async () => {
      if (!state.alive) throw new Error('closed');
    },
    close: () => state.closed++,
  }) as unknown as AgentHost;

describe('Connections', () => {
  it('reuses a live connection, and replaces it when the token changes', async () => {
    const urls: string[] = [];
    const c = new Connections({ connect: async (url) => (urls.push(url), fakeHost()) });
    const a = await c.get('p-0', { uid: 'u', url: 'ws://x/?tkn=1' });
    assert.equal(await c.get('p-0', { uid: 'u', url: 'ws://x/?tkn=1' }), a);
    assert.notEqual(await c.get('p-0', { uid: 'u', url: 'ws://x/?tkn=2' }), a);
    assert.equal(urls.length, 2);
  });

  it('reconnects at once when a connection died', async () => {
    const state = { alive: true, closed: 0 };
    let connects = 0;
    const c = new Connections({ connect: async () => (connects++, fakeHost(connects === 1 ? state : undefined)) });
    await c.get('p-0', { uid: 'u', url: 'ws://x' });
    state.alive = false;
    await c.get('p-0', { uid: 'u', url: 'ws://x' });
    assert.equal(connects, 2);
    assert.equal(state.closed, 1);
  });

  it('backs off after a failure', async () => {
    let now = 0;
    let connects = 0;
    const c = new Connections({
      now: () => now,
      connect: async () => {
        connects++;
        throw new Error('refused');
      },
    });
    await assert.rejects(c.get('p-0', { uid: 'u', url: 'ws://x' }), /refused/);
    await assert.rejects(c.get('p-0', { uid: 'u', url: 'ws://x' }), /refused \(retrying in 1s\)/);
    assert.equal(connects, 1);
    now += MIN_BACKOFF_MS;
    await assert.rejects(c.get('p-0', { uid: 'u', url: 'ws://x' }), /refused/);
    assert.equal(connects, 2);
  });

  it('closes the connections of pods that are gone', async () => {
    const state = { alive: true, closed: 0 };
    const c = new Connections({ connect: async () => fakeHost(state) });
    await c.get('p-0', { uid: 'u', url: 'ws://x' });
    c.retain(new Set());
    assert.equal(state.closed, 1);
  });
});

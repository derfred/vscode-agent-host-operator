// The fake host against a real one: the frames scripts/probe.ts recorded
// from a real host (test/fixtures/*.jsonl), replayed against FakeHost. Each
// action the probe dispatched must be answered the same way: echoed with its
// origin, refused (echoed with a rejectionReason), or applied and published
// with no origin. Record a new fixture with `npm run probe -- --record` when
// a new VS Code version answers differently (docs/testing.md, stage 1).

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { FakeHost } from './fake-host.ts';

type Frame = { readonly dir: 'in' | 'out'; readonly message: any };
type Answer = 'echoed' | 'refused' | 'published' | 'none';

const fixtures = join(import.meta.dirname, 'fixtures');

const published = (action: any, p: any) =>
  ((action.type === 'automation/createRequested' || action.type === 'automation/updateRequested') && p.type === 'automation/set' && p.automation?.resource === action.resource) ||
  (action.type === 'automation/removed' && p.type === 'automation/removed' && p.resource === action.resource) ||
  (action.type === 'root/configChanged' && p.type === 'root/configChanged');

// How each dispatched action was answered, in order.
function answers(frames: ReadonlyArray<Frame>): Array<[string, Answer]> {
  const out: Array<[string, Answer]> = [];
  for (const [i, frame] of frames.entries()) {
    if (frame.dir !== 'out' || frame.message.method !== 'dispatchAction') continue;
    const { clientSeq, action } = frame.message.params;
    let answer: Answer = 'none';
    for (const later of frames.slice(i + 1)) {
      if (later.dir !== 'in' || later.message.method !== 'action') continue;
      const envelope = later.message.params;
      if (envelope.origin?.clientSeq === clientSeq && envelope.action.type === action.type) {
        answer = envelope.rejectionReason ? 'refused' : 'echoed';
        break;
      }
      if (!envelope.origin && published(action, envelope.action)) {
        answer = 'published';
        break;
      }
    }
    out.push([action.type, answer]);
  }
  return out;
}

// The recorded dispatches, sent to a fake host; its frames back.
async function replay(recorded: ReadonlyArray<Frame>, fake: FakeHost): Promise<Frame[]> {
  const frames: Frame[] = [];
  const send = (message: any) => {
    frames.push({ dir: 'out', message });
    return fake.client.send(JSON.stringify(message));
  };
  // One recv() at a time, kept across drains: a frame is never dropped.
  let next = fake.client.recv();
  const drain = async () => {
    // The fake answers within a tick or two of each frame.
    for (;;) {
      const frame = await Promise.race([next, new Promise<'idle'>((resolve) => setTimeout(() => resolve('idle'), 20))]);
      if (frame === 'idle' || frame === null) return;
      next = fake.client.recv();
      frames.push({ dir: 'in', message: JSON.parse(frame.kind === 'text' ? frame.text : JSON.stringify((frame as any).message)) });
    }
  };
  await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientId: 'replay', protocolVersions: ['1.1.0'], initialSubscriptions: ['ahp-root://'] } });
  await send({ jsonrpc: '2.0', id: 2, method: 'subscribe', params: { channel: 'ahp-automations://' } });
  await drain();
  for (const frame of recorded) {
    if (frame.dir !== 'out' || frame.message.method !== 'dispatchAction') continue;
    await send(frame.message);
    await drain();
  }
  return frames;
}

describe('FakeHost conformance', () => {
  for (const file of readdirSync(fixtures).filter((f) => f.endsWith('.jsonl'))) {
    it(`answers dispatches as ${file.replace(/\.jsonl$/, '')} did`, async () => {
      const recorded: Frame[] = readFileSync(join(fixtures, file), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const expected = answers(recorded);
      assert.ok(expected.length > 0, 'the recording has dispatches');
      // Replay each dispatch on a fake that refuses exactly where the real
      // host did (the fake doesn't check schedules): one fake per dispatch,
      // with the catalogue and setting carried over.
      const actual: Array<[string, Answer]> = [];
      let catalog: FakeHost['catalog'] = new Map();
      let enabled = false;
      const dispatches = recorded.filter((f) => f.dir === 'out' && f.message.method === 'dispatchAction');
      for (const [i, frame] of dispatches.entries()) {
        const fake: FakeHost = new FakeHost(expected[i]![1] === 'refused' ? { reject: 'refused, as the real host did', automationsEnabled: enabled } : { automationsEnabled: enabled });
        for (const [k, v] of catalog) fake.catalog.set(k, v);
        actual.push(...answers(await replay([frame], fake)));
        catalog = fake.catalog;
        enabled = fake.automationsEnabled;
      }
      assert.deepEqual(actual, expected);
    });
  }
});

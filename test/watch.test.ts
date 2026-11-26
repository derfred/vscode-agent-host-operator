import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Trigger, watch } from '../src/watch.ts';

const list = (resourceVersion: string) => Response.json({ metadata: { resourceVersion }, items: [] });
// A watch stream, split into chunks at arbitrary points like a real one.
const stream = (events: ReadonlyArray<unknown>, chunkSize = 7) => {
  const text = events.map((e) => JSON.stringify(e) + '\n').join('');
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
        controller.close();
      },
    }),
  );
};
const event = (type: string, resourceVersion: string) => ({ type, object: { metadata: { resourceVersion } } });

// Serves `responses` in order to watch(), then stops it.
async function run(responses: Array<() => Response>) {
  const stop = new AbortController();
  const paths: string[] = [];
  const sleeps: number[] = [];
  let changes = 0;
  await watch({
    path: '/api/v1/namespaces/t3code/pods?labelSelector=app%3Dt3code',
    signal: stop.signal,
    onChange: () => changes++,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    get: async (path) => {
      paths.push(path);
      const next = responses.shift();
      if (!next) {
        stop.abort();
        throw new Error('stopped');
      }
      return next();
    },
  });
  return { paths, sleeps, changes: () => changes };
}

const rvOf = (path: string) => new URL(path, 'http://x').searchParams.get('resourceVersion');

describe('watch', () => {
  it('lists, then watches from that version, waking on changes but not bookmarks', async () => {
    const { paths, changes } = await run([
      () => list('10'),
      () => stream([event('ADDED', '11'), event('BOOKMARK', '12'), event('MODIFIED', '13'), event('DELETED', '14')]),
    ]);
    assert.equal(paths[0], '/api/v1/namespaces/t3code/pods?labelSelector=app%3Dt3code');
    const url = new URL(paths[1]!, 'http://x');
    assert.equal(url.searchParams.get('labelSelector'), 'app=t3code');
    assert.equal(url.searchParams.get('watch'), '1');
    assert.equal(url.searchParams.get('allowWatchBookmarks'), 'true');
    assert.equal(rvOf(paths[1]!), '10');
    // One for the list, three for the changes.
    assert.equal(changes(), 4);
  });

  it('resumes from the last version seen, a bookmark’s included, when the server ends the stream', async () => {
    const { paths } = await run([() => list('10'), () => stream([event('MODIFIED', '11'), event('BOOKMARK', '20')]), () => stream([])]);
    assert.equal(rvOf(paths[2]!), '20');
  });

  it('lists again when the version has expired, as a 410 or as an ERROR event', async () => {
    const { paths } = await run([
      () => list('10'),
      () => new Response('gone', { status: 410 }),
      () => list('30'),
      () => stream([{ type: 'ERROR', object: { code: 410, message: 'too old resource version' } }]),
      () => list('40'),
      () => stream([]),
    ]);
    // The last one is the stopping call, resuming after the clean end.
    assert.deepEqual(
      paths.map((p) => rvOf(p)),
      [null, '10', null, '30', null, '40', '40'],
    );
  });

  it('backs off on errors, doubling up to its cap, and resets once a watch opens', async () => {
    const fail = () => new Response('no', { status: 500 });
    const { sleeps } = await run([fail, fail, fail, fail, fail, fail, () => list('1'), () => stream([]), fail]);
    assert.deepEqual(sleeps, [1000, 2000, 4000, 8000, 16000, 30000, 1000]);
  });
});

describe('Trigger', () => {
  const never = new AbortController().signal;

  it('returns at once for a change that came before the wait', async () => {
    const trigger = new Trigger(0);
    trigger.notify();
    assert.equal(await trigger.wait(60_000, never), true);
  });

  it('wakes on a change during the wait, and times out without one', async () => {
    const trigger = new Trigger(0);
    setTimeout(() => trigger.notify(), 5);
    assert.equal(await trigger.wait(60_000, never), true);
    assert.equal(await trigger.wait(5, never), false);
  });

  it('folds several changes into one wake-up', async () => {
    const trigger = new Trigger(0);
    trigger.notify();
    trigger.notify();
    assert.equal(await trigger.wait(60_000, never), true);
    assert.equal(await trigger.wait(5, never), false);
  });

  it('returns when stopped', async () => {
    const trigger = new Trigger(0);
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 5);
    assert.equal(await trigger.wait(60_000, stop.signal), false);
  });
});

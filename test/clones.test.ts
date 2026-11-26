import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cloneCommand, Clones, type Exec } from '../src/clones.ts';

const request = { host: 'agents-fred-0', podUID: 'u1', container: 'agent-host', path: '/workspace/my-app', repository: 'https://example.com/my-app.git' };

describe('cloneCommand', () => {
  it('clones the default branch, or the ref, and ends the options before the URL', () => {
    assert.deepEqual(cloneCommand(request), ['git', 'clone', '--', request.repository, request.path]);
    assert.deepEqual(cloneCommand({ ...request, ref: 'main' }), ['git', 'clone', '--branch', 'main', '--', request.repository, request.path]);
  });
});

describe('Clones', () => {
  const clones = (exec: Exec) => new Clones({ exec, quickMs: 10, now: () => new Date('2026-11-26T10:00:00Z') });

  it('runs git in the container and records a clone that finished', async () => {
    const calls: unknown[] = [];
    const c = clones(async (...args) => {
      calls.push(args.slice(0, 3));
      return '';
    });
    const job = await c.start(request);
    assert.equal(job.phase, 'done');
    assert.equal(job.existing, false);
    assert.deepEqual(calls, [['agents-fred-0', 'agent-host', ['git', 'clone', '--', request.repository, request.path]]]);
  });

  it('keeps files that were there already', async () => {
    const c = clones(async () => {
      throw new Error("command terminated with non-zero exit code: fatal: destination path '/workspace/my-app' already exists and is not an empty directory.");
    });
    const job = await c.start(request);
    assert.deepEqual([job.phase, job.existing], ['done', true]);
  });

  it('records git’s error', async () => {
    const c = clones(async () => {
      throw new Error('fatal: repository not found');
    });
    const job = await c.start(request);
    assert.deepEqual([job.phase, job.error], ['failed', 'fatal: repository not found']);
  });

  it('answers running for a slow clone, and starts it only once', async () => {
    let finish!: () => void;
    let calls = 0;
    const c = clones(() => {
      calls++;
      return new Promise<string>((resolve) => (finish = () => resolve('')));
    });
    assert.equal((await c.start(request)).phase, 'running');
    assert.equal((await c.start(request)).phase, 'running');
    assert.equal(c.running(), true);
    assert.equal(calls, 1);
    finish();
    await c.settled();
    assert.equal(c.get(request.host, request.path)?.phase, 'done');
    assert.equal(c.running(), false);
  });
});

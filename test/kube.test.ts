import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execOutcome, toHost } from '../src/kube.ts';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('execOutcome', () => {
  it('is stdout, joined across messages, when the Status is Success', () => {
    const channels = new Map([
      [1, [bytes('Cloning '), bytes('into…')]],
      [3, [bytes('{"metadata":{},"status":"Success"}')]],
    ]);
    assert.deepEqual(execOutcome(channels), { ok: true, stdout: 'Cloning into…' });
  });

  it('is the Status message and stderr on failure', () => {
    const channels = new Map([
      [2, [bytes("fatal: destination path '/workspace/x' already exists and is not an empty directory.\n")]],
      [3, [bytes(JSON.stringify({ status: 'Failure', reason: 'NonZeroExitCode', message: 'command terminated with non-zero exit code: exit code 128' }))]],
    ]);
    assert.deepEqual(execOutcome(channels), {
      ok: false,
      error: "command terminated with non-zero exit code: exit code 128: fatal: destination path '/workspace/x' already exists and is not an empty directory.",
    });
  });

  it('fails without a Status', () => {
    assert.deepEqual(execOutcome(new Map([[1, [bytes('partial')]]])), { ok: false, error: 'the connection closed without an exit status' });
  });
});

describe('toHost', () => {
  it('reads ContainersReady, not Ready, which waits on the gate itself', () => {
    const pod = {
      metadata: { name: 'agents-fred-0', uid: 'u' },
      spec: { containers: [{ name: 'agent-host' }, { name: 'sidecar' }] },
      status: {
        podIP: '10.0.0.7',
        conditions: [
          { type: 'Ready', status: 'False' },
          { type: 'ContainersReady', status: 'True' },
          { type: 'agenthost.derfred.com/content-ready', status: 'False' },
        ],
      },
    };
    assert.deepEqual(toHost(pod), { name: 'agents-fred-0', uid: 'u', ip: '10.0.0.7', ready: true, contentReady: false, containers: ['agent-host', 'sidecar'] });
  });

  it('treats a terminating pod, or one without an IP, as not ready', () => {
    const conditions = [{ type: 'ContainersReady', status: 'True' }];
    assert.equal(toHost({ metadata: { name: 'p', uid: 'u', deletionTimestamp: 'now' }, status: { podIP: '10.0.0.8', conditions } }).ready, false);
    assert.equal(toHost({ metadata: { name: 'p', uid: 'u' }, status: { conditions } }).ready, false);
    assert.equal(toHost({ metadata: { name: 'p', uid: 'u' }, status: { podIP: '10.0.0.8', conditions } }).contentReady, undefined);
  });
});

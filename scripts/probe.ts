// Stage 1 of docs/testing.md: checks a real `code agent host` against what
// the operator assumes about it, through the operator's own AHP client
// (src/ahp.ts) and its own automation definitions (src/reconcile.ts).
//
//   node scripts/probe.ts --url 'ws://127.0.0.1:8081/?tkn=TOKEN' [options]
//   node scripts/probe.ts --port 8081 --token-file token [options]
//
//   --dir PATH          a writable folder on the host for P3 (default /tmp)
//   --wait-run          P8: also wait (up to --run-timeout, 180s) for an
//                       every-minute automation to run. Turns on the host's
//                       automationsEnabled setting, as the operator does.
//                       The run fails without agent credentials on the host;
//                       that it ran is what counts.
//   --keep              leave the P8 automation in the catalogue, for
//                       --after-restart
//   --after-restart     P8: after restarting the host, check the automation
//                       --keep left is still there, with a next run
//   --old-token TOKEN   P9: a token the host must now refuse
//   --record FILE       every frame, as JSON lines, for test/fake-host.ts
//   --provider NAME     the agent the probe's automations name (default claude)
//
// Exits 1 when a check fails. Everything the probe creates is named
// ahp-probe-* and removed again, except with --keep.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { AutomationEntry } from '@microsoft/agent-host-protocol';
import { AhpClient, type AhpTransport } from '@microsoft/agent-host-protocol/client';
import { WebSocketTransport } from '@microsoft/agent-host-protocol/ws';
import { PROTOCOL_VERSIONS, connectHost, fileUri, hostUrl, openHost, type AgentHost } from '../src/ahp.ts';
import { HASH_META, OWNER_META, automationDefinition, ownerOf } from '../src/reconcile.ts';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string' },
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '8081' },
    token: { type: 'string' },
    'token-file': { type: 'string' },
    dir: { type: 'string', default: '/tmp' },
    'wait-run': { type: 'boolean', default: false },
    'run-timeout': { type: 'string', default: '180' },
    keep: { type: 'boolean', default: false },
    'after-restart': { type: 'boolean', default: false },
    'old-token': { type: 'string' },
    record: { type: 'string' },
    provider: { type: 'string', default: 'claude' },
  },
});

const token = args.token ?? (args['token-file'] ? readFileSync(args['token-file'], 'utf8').trim() : undefined);
const url = args.url ?? (token !== undefined ? hostUrl(args.host!, Number(args.port), token) : undefined);
if (!url) {
  console.error('probe: give --url, or --token / --token-file (with --host, --port)');
  process.exit(2);
}

// ─── reporting ───────────────────────────────────────────────────────────────

type Result = { id: string; title: string; ok: boolean | null; detail: string };
const results: Result[] = [];

async function check(id: string, title: string, body: () => Promise<string | void>) {
  const started = Date.now();
  try {
    const detail = (await body()) ?? '';
    results.push({ id, title, ok: true, detail: `${detail}${detail ? ' ' : ''}(${Date.now() - started}ms)` });
    console.log(`PASS ${id} ${title}${detail ? `: ${detail}` : ''}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ id, title, ok: false, detail });
    console.log(`FAIL ${id} ${title}: ${detail}`);
  }
}
const skip = (id: string, title: string, why: string) => {
  results.push({ id, title, ok: null, detail: why });
  console.log(`SKIP ${id} ${title}: ${why}`);
};

// ─── recording ───────────────────────────────────────────────────────────────

const frames: string[] = [];
const record = (dir: 'out' | 'in', message: unknown) => {
  if (args.record) frames.push(JSON.stringify({ t: Date.now(), dir, message }));
};
function recorded(transport: AhpTransport): AhpTransport {
  return {
    send: (message) => {
      record('out', typeof message === 'string' ? JSON.parse(message) : message);
      return transport.send(message);
    },
    recv: async () => {
      const frame = await transport.recv();
      if (frame?.kind === 'text') record('in', JSON.parse(frame.text));
      else if (frame?.kind === 'parsed') record('in', frame.message);
      return frame;
    },
    close: () => transport.close(),
  };
}

const clientId = `ahp-probe-${randomUUID()}`;
const open = async (): Promise<AgentHost> =>
  openHost(recorded(await WebSocketTransport.connect(url)), { clientId, requestTimeoutMs: 15_000 });

const until = async <T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined>): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`no ${what} within ${timeoutMs / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
};

// The operator's definition for an AgentAutomation in a workspace at `path`.
const definitionFor = (name: string, path: string, spec: Record<string, unknown>) =>
  automationDefinition(
    { metadata: { name }, spec: { workspace: 'probe', prompt: 'Reply with the single word: pong.', agent: { provider: args.provider }, ...spec } } as never,
    { metadata: { name: 'probe' }, spec: { repository: 'https://example.invalid/probe.git', path } } as never,
  );
const entryOf = async (host: AgentHost, resource: string) => (await host.automationCatalog()).find((e) => e.resource === resource);
// Top-level definition fields the host changed or dropped, compared as JSON.
const drift = (sent: object, stored: object) =>
  [...new Set([...Object.keys(sent), ...Object.keys(stored)])].filter(
    (k) => JSON.stringify((sent as any)[k]) !== JSON.stringify((stored as any)[k]),
  );

// ─── the checks ──────────────────────────────────────────────────────────────

const KEPT = 'ahp-automation:/k8s-ahp-probe-kept';
const id = clientId.slice(-8);
const folder = `${args.dir!.replace(/\/$/, '')}/ahp-probe-${id}`;
let host: AgentHost | undefined;

await check('P1', 'initialize agrees on a version the operator offers; the root snapshot lists agents', async () => {
  host = await open();
  assert.ok(PROTOCOL_VERSIONS.includes(host.protocolVersion), `agreed ${host.protocolVersion}`);
  assert.ok(host.agents().length > 0, 'no agents in the root snapshot');
  return `${host.serverInfo}, AHP ${host.protocolVersion}, agents ${host.agents().join(', ')}`;
});
if (!host) {
  console.log('probe: no connection, nothing else to check');
  process.exit(1);
}
const h = host;

await check('P2', 'resourceList: a folder is listed, a missing one reads as not there (an RpcError)', async () => {
  const listed = await h.list(args.dir!);
  assert.ok(listed, `${args.dir} did not list`);
  assert.equal(await h.list(`${folder}-missing`), null);
  // What the error is, for the record (list() hides it).
  const raw = new AhpClient(recorded(await WebSocketTransport.connect(url)), { requestTimeoutMs: 15_000 });
  raw.connect();
  await raw.initialize({ clientId: `${clientId}-raw`, protocolVersions: [...PROTOCOL_VERSIONS] });
  const error = await raw.resourceList({ uri: fileUri(`${folder}-missing`) }).then(
    () => null,
    (e: any) => `${e.code} ${e.message}`,
  );
  await raw.shutdown().catch(() => undefined);
  assert.ok(error, 'listing a missing folder succeeded');
  return `${listed.length} entries in ${args.dir}; missing folder: ${error}`;
});

await check('P3', 'resourceDelete (recursive) removes a checkout-like tree; removing it again is quiet', async () => {
  const raw = new AhpClient(recorded(await WebSocketTransport.connect(url)), { requestTimeoutMs: 15_000 });
  raw.connect();
  await raw.initialize({ clientId: `${clientId}-files`, protocolVersions: [...PROTOCOL_VERSIONS] });
  try {
    await raw.resourceMkdir({ uri: fileUri(`${folder}/.git/objects`), recursive: true } as never);
    await raw.resourceWrite({ uri: fileUri(`${folder}/.git/HEAD`), data: 'ref: refs/heads/main\n', encoding: 'utf-8' } as never);
    await raw.resourceWrite({ uri: fileUri(`${folder}/README.md`), data: 'probe\n', encoding: 'utf-8' } as never);
  } finally {
    await raw.shutdown().catch(() => undefined);
  }
  const before = (await h.list(folder))?.map((e) => e.name).sort();
  assert.deepEqual(before, ['.git', 'README.md'], `made ${JSON.stringify(before)}`);
  await h.remove(folder);
  assert.equal(await h.list(folder), null, 'still there after remove');
  await h.remove(folder);
});

const supports = h.automations;
await check('P4', 'the host has an automation catalogue clients may add to (automations.create)', async () => {
  assert.ok(supports, 'InitializeResult.automations.create is missing');
  return `${(await h.automationCatalog()).length} entries`;
});

const resource = `ahp-automation:/k8s-ahp-probe-${id}`;
const definition = definitionFor(`ahp-probe-${id}`, args.dir!, { enabled: false, trigger: { schedule: '0 3 * * *', timeZone: 'Europe/Berlin' } });
let created = false;

if (!supports) {
  for (const [p, t] of [['P5', 'create'], ['P6', '_meta'], ['P7', 'rejection'], ['P8', 'runs']]) skip(p!, t!, 'no automation catalogue');
} else {
  await check('P5', 'automation/createRequested is accepted: echoed with our origin, or published as automation/set', async () => {
    await h.createAutomation(resource, definition);
    created = true;
    const entry = await until('catalogue entry', 10_000, () => entryOf(h, resource));
    return `entry has operations ${JSON.stringify(entry.operations)}, nextRunAt ${entry.nextRunAt ?? 'none'}`;
  });

  await check('P6', '_meta (owner, hash) and the rest of the definition survive create and update', async () => {
    assert.ok(created, 'P5 created nothing');
    const entry = (await entryOf(h, resource))!;
    const changed = drift(definition, entry.definition);
    assert.equal(ownerOf(entry), `ahp-probe-${id}`);
    assert.equal(entry.definition._meta?.[HASH_META], (definition as any)._meta[HASH_META], 'hash lost: the operator would update every pass');
    assert.ok(entry.operations?.includes('update' as never) && entry.operations?.includes('remove' as never), `operations ${JSON.stringify(entry.operations)}`);
    const next = definitionFor(`ahp-probe-${id}`, args.dir!, { enabled: false, title: 'probe, updated', trigger: { schedule: '30 3 * * *', timeZone: 'Europe/Berlin' } });
    await h.updateAutomation(resource, next as never);
    const updated = await until('the update', 10_000, async () => {
      const e = await entryOf(h, resource);
      return e?.definition.title === 'probe, updated' ? e : undefined;
    });
    assert.equal(updated.definition._meta?.[HASH_META], (next as any)._meta[HASH_META], 'hash not updated');
    assert.equal(updated.definition._meta?.[OWNER_META], `ahp-probe-${id}`);
    const afterUpdate = drift(next, updated.definition);
    return `fields the host changed: on create ${JSON.stringify(changed)}, on update ${JSON.stringify(afterUpdate)}`;
  });

  await check('P7', 'a definition the host refuses comes back with a rejectionReason', async () => {
    const bad = definitionFor(`ahp-probe-${id}-bad`, args.dir!, { enabled: false });
    (bad as any).triggers = [{ id: 'schedule', kind: 'schedule', schedule: { expression: 'every tuesday', timeZone: 'Nowhere/Nothing' } }];
    const outcome = await h.createAutomation(`${resource}-bad`, bad).then(
      () => null,
      (e: Error) => e.message,
    );
    if (outcome === null) {
      await h.removeAutomation(`${resource}-bad`).catch(() => undefined);
      throw new Error('the host accepted a schedule of "every tuesday" in Nowhere/Nothing');
    }
    assert.match(outcome, /refused/, outcome);
    return outcome;
  });

  await check('P5b', 'automation/removed is accepted and the entry goes', async () => {
    assert.ok(created, 'P5 created nothing');
    await h.removeAutomation(resource);
    await until('the entry to go', 10_000, async () => ((await entryOf(h, resource)) ? undefined : true));
  });

  if (args['after-restart']) {
    await check('P8', 'after a host restart, the kept automation is still there, with a next run', async () => {
      assert.ok(h.automationsEnabled(), 'automationsEnabled is off again');
      const entry = await entryOf(h, KEPT);
      assert.ok(entry, `${KEPT} is gone`);
      assert.ok(entry.nextRunAt && Date.parse(entry.nextRunAt) > Date.now() - 60_000, `nextRunAt ${entry.nextRunAt}: not scheduled`);
      const runs = (entry.runs ?? []).map((r: any) => `${r.lifecycle?.status}@${r.lifecycle?.createdAt}`);
      if (!args.keep) await h.removeAutomation(KEPT);
      return `nextRunAt ${entry.nextRunAt}; runs ${JSON.stringify(runs)}`;
    });
  } else if (args['wait-run']) {
    await check('P8', 'an every-minute automation runs on schedule (automationsEnabled on, as the operator sets it)', async () => {
      // Off on a new host: definitions are kept, nothing runs.
      const wasOn = h.automationsEnabled();
      if (!wasOn) await h.enableAutomations();
      if ((await entryOf(h, KEPT)) !== undefined) await h.removeAutomation(KEPT);
      await h.createAutomation(KEPT, definitionFor('ahp-probe-kept', args.dir!, { trigger: { schedule: '* * * * *', timeZone: 'UTC' } }));
      const entry = await until('a run', Number(args['run-timeout']) * 1000, async () => {
        const e = await entryOf(h, KEPT);
        return (e?.runs?.length ?? 0) > 0 ? e : undefined;
      });
      const run = entry!.runs![0] as any;
      if (!args.keep) await h.removeAutomation(KEPT);
      return `automationsEnabled was ${wasOn ? 'on' : 'off, turned on'}; run ${run.lifecycle?.status} at ${run.lifecycle?.createdAt}${run.lifecycle?.error ? `: ${run.lifecycle.error.message}` : ''}; nextRunAt ${entry!.nextRunAt}${args.keep ? '; kept for --after-restart' : ''}`;
    });
  } else {
    skip('P8', 'runs on schedule, and across a restart', 'pass --wait-run --keep, restart the host, then --after-restart');
  }
}

if (args['old-token']) {
  await check('P9', 'the host refuses a token it no longer has', async () => {
    const old = hostUrl(new URL(url).hostname.replace(/^\[|\]$/g, ''), Number(new URL(url).port), args['old-token']!);
    const outcome = await connectHost(old, { clientId: `${clientId}-old` }).then(
      (c) => (c.close(), null),
      (e: Error) => e.message,
    );
    assert.ok(outcome, 'connected with the old token');
    return outcome;
  });
} else {
  skip('P9', 'the old token is refused after rotation', 'pass --old-token after changing the token file and restarting the host');
}

h.close();
if (args.record) {
  writeFileSync(args.record, frames.join('\n') + '\n');
  console.log(`probe: ${frames.length} frames in ${args.record}`);
}
const failed = results.filter((r) => r.ok === false);
console.log(`probe: ${results.filter((r) => r.ok).length} passed, ${failed.length} failed, ${results.filter((r) => r.ok === null).length} skipped`);
process.exit(failed.length ? 1 : 0);

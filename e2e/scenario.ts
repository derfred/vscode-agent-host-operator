// The end-to-end scenario (docs/testing.md, stage 2). It drives the operator
// only through the (fake) Kubernetes API, as kubectl would, and checks the
// results in the agent hosts themselves, over AHP.
//
// The operator's resync is left at its default (5 minutes): every reaction
// here is timed far below it, so a passing run also shows the watches work.

import assert from 'node:assert/strict';
import type { AutomationEntry } from '@microsoft/agent-host-protocol';
import type { FakeApiServer } from './fake-apiserver.ts';
import type { Host } from './hosts.ts';
import { PROTOCOL_VERSIONS, connectHost, hostUrl } from '../src/ahp.ts';

export const NAMESPACE = 'agents';
const STATEFUL_SET = 'agents-e2e';
const GROUP = 'agenthost.derfred.com';
const GATE = `${GROUP}/content-ready`;
const FINALIZER = `${GROUP}/cleanup`;
const OWNER_META = `${GROUP}/automation`;

const pods = `/api/v1/namespaces/${NAMESPACE}/pods`;
const secrets = `/api/v1/namespaces/${NAMESPACE}/secrets`;
const statefulSets = `/apis/apps/v1/namespaces/${NAMESPACE}/statefulsets`;
const custom = `/apis/${GROUP}/v1alpha1/namespaces/${NAMESPACE}`;
const sets = `${custom}/agenthostsets`;
const workspaces = `${custom}/agentworkspaces`;
const automations = `${custom}/agentautomations`;

export interface Context {
  readonly api: FakeApiServer;
  // Two hosts: the pods <set>-0 and <set>-1.
  readonly hosts: ReadonlyArray<Host>;
  readonly token: string;
  readonly restartOperator: () => Promise<void>;
}

const step = (message: string) => console.log(`e2e: ${message}`);

async function until<T>(what: string, timeoutMs: number, probe: () => T | undefined | false | Promise<T | undefined | false>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined && value !== false) return value as T;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}${last ? `: ${last}` : ''}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function run({ api, hosts, token, restartOperator }: Context): Promise<void> {
  const [h0, h1] = hosts as [Host, Host];
  // Where workspaces go: the same path on every host, as on pods.
  const root = h0.workspaceRoot;
  const remote = h0.remote;

  // ─── the hosts, as the API sees them ───────────────────────────────────────

  api.create(secrets, {
    metadata: { name: 'agents-e2e-token' },
    data: { token: Buffer.from(token).toString('base64') },
  });
  api.create(statefulSets, { metadata: { name: STATEFUL_SET }, spec: { selector: { matchLabels: { app: 'agent-host', set: 'e2e' } } } });
  const podOf = (host: Host) => ({
    metadata: { name: host.name, labels: { app: 'agent-host', set: 'e2e' } },
    spec: { readinessGates: [{ conditionType: GATE }], containers: [{ name: 'agent-host' }] },
    status: { podIP: host.ip, conditions: [{ type: 'ContainersReady', status: 'True' }] },
  });
  for (const host of hosts) api.create(pods, podOf(host));
  api.create(sets, {
    metadata: { name: 'e2e', labels: { owner: 'e2e' } },
    spec: {
      statefulSet: STATEFUL_SET,
      port: h0.port,
      connectionToken: { secretName: 'agents-e2e-token' },
      address: 'wss://{pod}.example.ts.net',
    },
  });
  const gate = (host: Host) => api.get(pods, host.name)?.status?.conditions?.find((c: any) => c.type === GATE)?.status;
  const setHosts = () => (api.get(sets, 'e2e')?.status?.hosts ?? []) as any[];
  const containersReady = (host: Host, ready: boolean) => {
    const conditions = api.get(pods, host.name)!.status.conditions.map((c: any) =>
      c.type === 'ContainersReady' ? { ...c, status: ready ? 'True' : 'False' } : c,
    );
    api.patch(pods, host.name, { status: { conditions } });
  };

  // 1. The set connects to both hosts and reports them.
  await until('the AgentHostSet to be Ready', 60_000, () => api.get(sets, 'e2e')?.status?.phase === 'Ready');
  for (const [i, h] of setHosts().entries()) {
    assert.equal(h.pod, hosts[i]!.name);
    assert.equal(h.address, `wss://${hosts[i]!.name}.example.ts.net`);
    assert.ok(PROTOCOL_VERSIONS.includes(h.protocolVersion), `protocol ${h.protocolVersion}`);
    assert.ok(h.agents.length > 0, 'agents');
  }
  await until('both gates open (no workspaces yet)', 15_000, () => hosts.every((h) => gate(h) === 'True'));
  step(`1. AgentHostSet Ready: ${setHosts().map((h) => `${h.pod} ${h.serverInfo}, AHP ${h.protocolVersion}, ${h.agents.join('/')}`).join('; ')}`);

  // Our own view of each host's automation catalogue, over AHP.
  const catalogs = new Map<Host, Awaited<ReturnType<typeof connectHost>>>();
  const catalog = async (host: Host): Promise<ReadonlyArray<AutomationEntry>> => {
    let c = catalogs.get(host);
    if (!c || !c.alive()) {
      c = await connectHost(hostUrl(host.ip, host.port, token), { clientId: `e2e-${host.name}-${Date.now()}` });
      catalogs.set(host, c);
    }
    return (await c.automationCatalog()).filter((e) => typeof e.definition._meta?.[OWNER_META] === 'string');
  };
  const automationsOn = async (host: Host) => {
    await catalog(host);
    return catalogs.get(host)!.automationsEnabled();
  };
  const owned = async (host: Host, owner: string) => (await catalog(host)).filter((e) => e.definition._meta?.[OWNER_META] === owner);
  const inHost = async (host: Host, path: string) => {
    const out = await host.exec(['sh', '-c', `ls -A ${path} 2>/dev/null`]);
    return out.exitCode === 0 ? out.stdout.split('\n').filter(Boolean) : null;
  };

  try {
    // 2. A workspace clones onto every host of the set; the gates follow.
    api.create(workspaces, {
      metadata: { name: 'demo' },
      spec: { repository: remote, path: `${root}/demo`, hostSetSelector: { matchLabels: { owner: 'e2e' } } },
    });
    const gateHistory: string[] = [];
    const watchGate = setInterval(() => {
      const g = gate(h0);
      if (gateHistory.at(-1) !== g) gateHistory.push(g);
    }, 50);
    await until('the finalizer', 15_000, () => api.get(workspaces, 'demo')?.metadata.finalizers?.includes(FINALIZER));
    const demo = await until('workspace demo Ready', 120_000, () => {
      const w = api.get(workspaces, 'demo');
      return w?.status?.phase === 'Ready' ? w : undefined;
    });
    clearInterval(watchGate);
    assert.deepEqual(demo.status.hosts.map((h: any) => [h.pod, h.phase]), hosts.map((h) => [h.name, 'Ready']));
    for (const host of hosts) {
      const head = await host.exec(['git', '-C', `${root}/demo`, 'log', '-1', '--format=%s']);
      assert.equal(head.stdout.trim(), 'init', `${host.name}: ${head.stderr}`);
    }
    await until('both gates open', 15_000, () => hosts.every((h) => gate(h) === 'True'));
    step(`2. workspace demo cloned onto both hosts; ${h0.name}'s gate went ${gateHistory.join(' → ')}`);

    // 3. A repository git can't clone: Error with git's message, and the
    // gate not held, so a typo can't stall a rollout.
    api.create(workspaces, {
      metadata: { name: 'broken' },
      spec: { repository: `${remote}-missing`, path: `${root}/broken`, deletionPolicy: 'Delete', hostSetSelector: { matchLabels: { owner: 'e2e' } } },
    });
    const broken = await until('workspace broken Error', 60_000, () => {
      const w = api.get(workspaces, 'broken');
      return w?.status?.phase === 'Error' ? w : undefined;
    });
    assert.match(broken.status.hosts[0].message, /missing/);
    assert.equal(gate(h0), 'True', 'an Error does not hold the gate');
    await until('the set to report the failure', 15_000, () => setHosts()[0]?.phase === 'Degraded');
    step(`3. bad repository: Error (${broken.status.hosts[0].message.split('\n')[0]}), gate open, set ${api.get(sets, 'e2e')?.status?.phase}`);
    api.delete(workspaces, 'broken');
    await until('workspace broken gone', 30_000, () => api.get(workspaces, 'broken') === undefined);
    await until('the set Ready again', 15_000, () => api.get(sets, 'e2e')?.status?.phase === 'Ready');

    // 4. A folder that is already there, with files, is taken as it is.
    for (const host of hosts) await host.exec(['sh', '-c', `mkdir -p ${root}/existing && echo mine > ${root}/existing/notes.txt`]);
    api.create(workspaces, {
      metadata: { name: 'existing' },
      spec: { repository: remote, path: `${root}/existing`, hostSetSelector: { matchLabels: { owner: 'e2e' } } },
    });
    await until('workspace existing Ready', 60_000, () => api.get(workspaces, 'existing')?.status?.phase === 'Ready');
    for (const host of hosts) assert.deepEqual(await inHost(host, `${root}/existing`), ['notes.txt'], `${host.name}: not cloned over`);
    step('4. an existing folder is kept as it is, not cloned over');

    // 5. An automation: created on one host, updated once on a change, not
    // on every pass, and removed with its resource.
    api.create(automations, {
      metadata: { name: 'nightly' },
      spec: {
        workspace: 'demo',
        prompt: 'Say hello.',
        agent: { provider: 'claude' },
        // Never fires during the run.
        enabled: false,
        trigger: { schedule: '0 3 * * *', timeZone: 'Europe/Berlin' },
      },
    });
    const nightly = await until('automation nightly Ready', 60_000, () => {
      const a = api.get(automations, 'nightly');
      return a?.status?.phase === 'Ready' ? a : undefined;
    });
    assert.deepEqual(nightly.status.hosts.map((h: any) => h.pod), [h0.name], 'placement One: the lowest ordinal');
    const [entry] = await owned(h0, 'nightly');
    assert.ok(entry, `nightly in ${h0.name}'s catalogue`);
    assert.equal(entry.resource, nightly.status.hosts[0].resource);
    assert.equal(entry.definition.session?.workingDirectories?.[0], `file://${root}/demo`);
    assert.deepEqual(await owned(h1, 'nightly'), [], `not on ${h1.name}`);
    assert.equal(await automationsOn(h0), false, 'a disabled automation leaves automationsEnabled alone');
    step(`5a. automation nightly in ${h0.name}'s catalogue as ${entry.resource}`);

    // A pass that changes nothing for it (a label on another resource) leaves
    // the entry alone.
    api.patch(workspaces, 'existing', { metadata: { labels: { touched: 'yes' } } });
    await sleep(3000);
    assert.equal((await owned(h0, 'nightly'))[0]?.modifiedAt, entry.modifiedAt, 'no update without a change');
    api.patch(automations, 'nightly', { spec: { title: 'Nightly hello' } });
    await until('the new title on the host', 15_000, async () => (await owned(h0, 'nightly'))[0]?.definition.title === 'Nightly hello');
    const updated = (await owned(h0, 'nightly'))[0]!;
    await sleep(3000);
    assert.equal((await owned(h0, 'nightly'))[0]?.modifiedAt, updated.modifiedAt, 'updated once');
    step('5b. a spec change updated the entry once; passes without one leave it alone');

    // 6. EachHost, and enabled: on both, each host's automationsEnabled
    // turned on, and the next run in status. The schedule is a year away.
    api.create(automations, {
      metadata: { name: 'everywhere' },
      spec: { workspace: 'demo', prompt: 'Say hello.', agent: { provider: 'claude' }, placement: 'EachHost', trigger: { schedule: '0 4 1 1 *' } },
    });
    const everywhere = await until('automation everywhere Ready', 60_000, () => {
      const a = api.get(automations, 'everywhere');
      return a?.status?.phase === 'Ready' ? a : undefined;
    });
    for (const host of hosts) {
      assert.equal((await owned(host, 'everywhere')).length, 1, `everywhere on ${host.name}`);
      assert.equal(await automationsOn(host), true, `automationsEnabled on ${host.name}`);
    }
    assert.ok(everywhere.status.hosts.every((h: any) => h.nextRunAt), 'nextRunAt in status');
    step(`6. placement EachHost: on both hosts, automations turned on, next run ${everywhere.status.hosts[0].nextRunAt}`);

    // 7. A missing token Secret: the hosts are Error, with a message that says
    // so, and the gates are not held. Back to Ready when it is fixed.
    api.patch(sets, 'e2e', { spec: { connectionToken: { secretName: 'no-such-secret' } } });
    const noToken = await until('the hosts Error for want of a token', 30_000, () => {
      const hs = setHosts();
      return hs.length === 2 && hs.every((h) => h.phase === 'Error') ? hs : undefined;
    });
    assert.match(noToken[0].message, /no-such-secret/);
    assert.ok(hosts.every((h) => gate(h) === 'True'), 'the gates are not held');
    step(`7. missing Secret: hosts Error (${noToken[0].message})`);
    api.patch(sets, 'e2e', { spec: { connectionToken: { secretName: 'agents-e2e-token' } } });
    await until('the set Ready again', 30_000, () => api.get(sets, 'e2e')?.status?.phase === 'Ready');

    // 8. The operator restarts: it picks up where it was and changes nothing.
    const snapshot = async () => ({
      statuses: [sets, workspaces, automations].map((c) => api.list(c).map((o) => [o.metadata.name, o.status?.phase])),
      entries: await Promise.all(hosts.map(async (h) => (await catalog(h)).map((e) => [e.resource, e.modifiedAt]).sort())),
    });
    const before = await snapshot();
    await restartOperator();
    await sleep(8000);
    assert.deepEqual(await snapshot(), before, 'a restarted operator changes nothing');
    step('8. operator restarted: no status changes, no catalogue changes');

    // 9. A host restarts (the pod goes unready and back): the operator
    // reconnects, and its automations are still there, once.
    containersReady(h0, false);
    await until(`${h0.name} Pending`, 15_000, () => setHosts()[0]?.phase === 'Pending');
    await h0.restart();
    containersReady(h0, true);
    await until('the set Ready again', 60_000, () => api.get(sets, 'e2e')?.status?.phase === 'Ready');
    await until('the automations Ready', 30_000, () => ['nightly', 'everywhere'].every((n) => api.get(automations, n)?.status?.phase === 'Ready'));
    assert.equal((await owned(h0, 'nightly')).length, 1, 'nightly once');
    assert.equal((await owned(h0, 'everywhere')).length, 1, 'everywhere once');
    assert.equal((await owned(h0, 'nightly'))[0]?.definition.title, 'Nightly hello', 'kept across the restart');
    assert.equal(await automationsOn(h0), true, 'automationsEnabled kept across the restart');
    step(`9. ${h0.name} restarted: reconnected, catalogue kept, nothing duplicated`);

    // Cleanup, which is also a check: deleting the automations takes them off
    // the hosts; deleting a Retain workspace leaves its folder.
    api.delete(automations, 'nightly');
    api.delete(automations, 'everywhere');
    await until('the automations gone', 30_000, () => !api.get(automations, 'nightly') && !api.get(automations, 'everywhere'));
    for (const host of hosts) assert.deepEqual(await catalog(host), [], `${host.name}'s catalogue emptied`);
    api.delete(workspaces, 'demo');
    api.delete(workspaces, 'existing');
    await until('the workspaces gone', 30_000, () => !api.get(workspaces, 'demo') && !api.get(workspaces, 'existing'));
    assert.ok((await inHost(h0, `${root}/demo`))?.includes('.git'), 'Retain keeps the folder');
    step('deleting the automations emptied the catalogues; deleting a Retain workspace kept its folder');
  } finally {
    for (const c of catalogs.values()) c.close();
  }
}

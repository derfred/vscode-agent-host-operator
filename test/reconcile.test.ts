import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openHost, type AgentHost } from '../src/ahp.ts';
import { Clones, type Exec } from '../src/clones.ts';
import type { Host, Kube } from '../src/kube.ts';
import {
  CLONE_GATE_MS,
  CLONE_RETRY_MS,
  FINALIZER,
  HASH_META,
  OWNER_META,
  automationDefinition,
  choosePlacement,
  holdsGate,
  reconcileAutomations,
  reconcileHostSet,
  reconcileWorkspace,
  World,
  type AutomationResource,
  type HostSetResource,
  type PlacedSet,
  type WorkspaceHostStatus,
  type WorkspaceResource,
} from '../src/reconcile.ts';
import { FakeHost } from './fake-host.ts';

const NOW = new Date('2026-11-26T10:00:00.000Z');

function fakeKube() {
  const calls = {
    patches: [] as Array<{ plural: string; name: string; body: any }>,
    statuses: [] as Array<{ plural: string; name: string; status: any }>,
    gates: [] as Array<{ pod: string; ready: boolean; message: string }>,
  };
  const kube = {
    patch: async (plural: string, name: string, body: unknown) => void calls.patches.push({ plural, name, body }),
    patchStatus: async (plural: string, name: string, status: unknown) => void calls.statuses.push({ plural, name, status }),
    setContentReady: async (pod: string, ready: boolean, message: string) => void calls.gates.push({ pod, ready, message }),
  } as unknown as Kube;
  return { kube, calls, lastStatus: (name: string) => calls.statuses.filter((s) => s.name === name).at(-1)?.status };
}

const host = (name: string, fields: Partial<Host> = {}): Host => ({
  name,
  uid: `uid-${name}`,
  ip: '10.0.0.1',
  ready: true,
  contentReady: undefined,
  containers: ['agent-host'],
  ...fields,
});

const set = (name: string, hosts: Host[] | null, labels: Record<string, string> = { owner: 'fred' }): PlacedSet => ({
  name,
  labels,
  spec: { statefulSet: `agents-${name}`, connectionToken: { secretName: 't' }, address: 'wss://{pod}.example.ts.net' },
  hosts,
});

const workspace = (fields: Partial<WorkspaceResource['spec']> = {}, metadata: Partial<WorkspaceResource['metadata']> = {}, status?: any): WorkspaceResource => ({
  metadata: { name: 'my-app', finalizers: [FINALIZER], generation: 1, ...metadata },
  spec: { repository: 'https://example.com/my-app.git', ...fields },
  ...(status ? { status } : {}),
});

const automation = (fields: Partial<AutomationResource['spec']> = {}, metadata: Partial<AutomationResource['metadata']> = {}, status?: any): AutomationResource => ({
  metadata: { name: 'deps', finalizers: [FINALIZER], generation: 1, ...metadata },
  spec: { workspace: 'my-app', prompt: 'Check for outdated dependencies.', agent: { provider: 'claude' }, trigger: { schedule: '0 3 * * 1-5' }, ...fields },
  ...(status ? { status } : {}),
});

const connect = (fake: FakeHost) => openHost(fake.client, { clientId: 'operator', requestTimeoutMs: 2_000 });

function deps(kube: Kube, exec: Exec = async () => '') {
  return { kube, clones: new Clones({ exec, quickMs: 10, now: () => NOW }), now: () => NOW };
}

describe('choosePlacement', () => {
  it('One: the lowest ordinal that is ready, and it stays where it is', () => {
    assert.deepEqual(choosePlacement('One', ['p-0', 'p-1', 'p-2'], ['p-10', 'p-2'], []), ['p-2']);
    assert.deepEqual(choosePlacement(undefined, ['p-0', 'p-1'], ['p-0', 'p-1'], ['p-1']), ['p-1']);
    assert.deepEqual(choosePlacement('One', ['p-0'], [], []), []);
  });
  it('EachHost: every ready one, and those that hold it', () => {
    assert.deepEqual(choosePlacement('EachHost', ['p-0', 'p-1', 'p-2'], ['p-0'], ['p-2', 'p-9']), ['p-0', 'p-2']);
  });
});

describe('holdsGate', () => {
  it('holds while Waiting, and Cloning for up to CLONE_GATE_MS, never on Error', () => {
    assert.equal(holdsGate({ workspace: 'w', phase: 'Waiting', since: null }, NOW), true);
    assert.equal(holdsGate({ workspace: 'w', phase: 'Cloning', since: NOW.toISOString() }, NOW), true);
    assert.equal(holdsGate({ workspace: 'w', phase: 'Cloning', since: new Date(NOW.getTime() - CLONE_GATE_MS).toISOString() }, NOW), false);
    assert.equal(holdsGate({ workspace: 'w', phase: 'Error', since: null }, NOW), false);
    assert.equal(holdsGate({ workspace: 'w', phase: 'Ready', since: null }, NOW), false);
  });
});

describe('reconcileWorkspace', () => {
  it('adds its finalizer, and clones onto every host of the sets it selects', async () => {
    const { kube, calls, lastStatus } = fakeKube();
    const fake = new FakeHost();
    const world = new World([set('fred', [host('agents-fred-0')]), set('team', [host('agents-team-0')], { owner: 'team' })], new Map([['agents-fred-0', await connect(fake)]]));
    const execs: unknown[] = [];
    const d = deps(kube, async (...args) => (execs.push(args.slice(0, 3)), ''));
    const statuses = await reconcileWorkspace(d, workspace({ hostSetSelector: { matchLabels: { owner: 'fred' } } }, { finalizers: [] }), world);
    assert.deepEqual(calls.patches[0]?.body.metadata.finalizers, [FINALIZER]);
    assert.deepEqual(execs, [['agents-fred-0', 'agent-host', ['git', 'clone', '--', 'https://example.com/my-app.git', '/workspace/my-app']]]);
    assert.deepEqual(statuses.map((s) => [s.pod, s.phase, s.repository]), [['agents-fred-0', 'Ready', 'https://example.com/my-app.git']]);
    assert.equal(lastStatus('my-app').phase, 'Ready');
  });

  it('keeps files already in the folder, without cloning', async () => {
    const { kube } = fakeKube();
    const fake = new FakeHost({ files: { '/workspace/my-app': ['README.md'] } });
    const world = new World([set('fred', [host('p-0')])], new Map([['p-0', await connect(fake)]]));
    let cloned = false;
    const [status] = await reconcileWorkspace(deps(kube, async () => ((cloned = true), '')), workspace(), world);
    assert.equal(cloned, false);
    assert.deepEqual([status!.phase, status!.message], ['Ready', 'kept the files already in /workspace/my-app']);
  });

  it('is Cloning while git runs, then Ready', async () => {
    const { kube } = fakeKube();
    const world = new World([set('fred', [host('p-0')])], new Map([['p-0', await connect(new FakeHost())]]));
    let finish!: () => void;
    const d = deps(kube, () => new Promise((resolve) => (finish = () => resolve(''))));
    const [cloning] = await reconcileWorkspace(d, workspace(), world);
    assert.deepEqual([cloning!.phase, cloning!.since], ['Cloning', NOW.toISOString()]);
    finish();
    await d.clones.settled();
    const [ready] = await reconcileWorkspace(d, workspace({}, {}, { hosts: [cloning] }), world);
    assert.equal(ready!.phase, 'Ready');
  });

  it('is Error on a failed clone, retried after CLONE_RETRY_MS or for a changed repository', async () => {
    const { kube } = fakeKube();
    const world = new World([set('fred', [host('p-0')])], new Map([['p-0', await connect(new FakeHost())]]));
    let now = NOW;
    let attempts = 0;
    const d = {
      kube,
      now: () => now,
      clones: new Clones({
        quickMs: 10,
        now: () => now,
        exec: async () => {
          attempts++;
          throw new Error('fatal: repository not found');
        },
      }),
    };
    const [failed] = await reconcileWorkspace(d, workspace(), world);
    assert.deepEqual([failed!.phase, failed!.message], ['Error', 'clone of https://example.com/my-app.git into /workspace/my-app failed: fatal: repository not found']);
    await reconcileWorkspace(d, workspace({}, {}, { hosts: [failed] }), world);
    assert.equal(attempts, 1);
    await reconcileWorkspace(d, workspace({ repository: 'https://example.com/fixed.git' }, {}, { hosts: [failed] }), world);
    assert.equal(attempts, 2);
    now = new Date(NOW.getTime() + CLONE_RETRY_MS);
    await reconcileWorkspace(d, workspace({ repository: 'https://example.com/fixed.git' }, {}, { hosts: [failed] }), world);
    assert.equal(attempts, 3);
  });

  it('is Waiting on a pod that is not ready, and Error on one it cannot connect to', async () => {
    const { kube } = fakeKube();
    const world = new World([set('fred', [host('p-0', { ready: false }), host('p-1')])], new Map([['p-1', new Error('token refused')]]));
    const statuses = await reconcileWorkspace(deps(kube), workspace(), world);
    assert.deepEqual(
      statuses.map((s) => [s.pod, s.phase, s.message]),
      [
        ['p-0', 'Waiting', 'pod not ready'],
        ['p-1', 'Error', 'no connection to the host: token refused'],
      ],
    );
  });

  it('on deletion with deletionPolicy Delete, removes the folder, then its finalizer', async () => {
    const { kube, calls } = fakeKube();
    const fake = new FakeHost({ files: { '/workspace/my-app': ['README.md'] } });
    const world = new World([set('fred', [host('p-0')])], new Map([['p-0', await connect(fake)]]));
    const previous: WorkspaceHostStatus = { pod: 'p-0', hostSet: 'fred', phase: 'Ready', message: null, podUID: 'uid-p-0', repository: null, since: null };
    await reconcileWorkspace(deps(kube), workspace({ deletionPolicy: 'Delete' }, { deletionTimestamp: NOW.toISOString() }, { hosts: [previous] }), world);
    assert.equal(fake.files.has('/workspace/my-app'), false);
    assert.deepEqual(calls.patches.at(-1)?.body.metadata.finalizers, []);
  });

  it('on deletion with Retain, keeps the folder', async () => {
    const { kube, calls } = fakeKube();
    const fake = new FakeHost({ files: { '/workspace/my-app': ['README.md'] } });
    const world = new World([set('fred', [host('p-0')])], new Map([['p-0', await connect(fake)]]));
    const previous: WorkspaceHostStatus = { pod: 'p-0', hostSet: 'fred', phase: 'Ready', message: null, podUID: 'uid-p-0', repository: null, since: null };
    await reconcileWorkspace(deps(kube), workspace({}, { deletionTimestamp: NOW.toISOString() }, { hosts: [previous] }), world);
    assert.equal(fake.files.has('/workspace/my-app'), true);
    assert.deepEqual(calls.patches.at(-1)?.body.metadata.finalizers, []);
  });
});

describe('automationDefinition', () => {
  it('carries the prompt, the workspace folder, the agent and the schedule, marked as the operator’s', () => {
    const d = automationDefinition(
      automation({ agent: { provider: 'claude', model: 'claude-sonnet-5-5' }, config: { permissionMode: 'default' }, trigger: { schedule: '0 3 * * 1-5', timeZone: 'Europe/Berlin' } }),
      workspace({ path: '/workspace/app' }),
    ) as any;
    assert.equal(d.title, 'deps');
    assert.deepEqual(d.message, { text: 'Check for outdated dependencies.', origin: { kind: 'automation' } });
    assert.deepEqual(d.session, { provider: 'claude', model: { id: 'claude-sonnet-5-5' }, workingDirectories: ['file:///workspace/app'], config: { permissionMode: 'default' } });
    assert.deepEqual(d.triggers, [{ id: 'schedule', kind: 'schedule', schedule: { expression: '0 3 * * 1-5', timeZone: 'Europe/Berlin' } }]);
    assert.equal(d._meta[OWNER_META], 'deps');
    assert.match(d._meta[HASH_META], /^[0-9a-f]{16}$/);
  });
  it('without a schedule is manual-only', () => {
    assert.deepEqual((automationDefinition(automation({ trigger: undefined }), workspace()) as any).triggers, []);
  });
  it('refuses one without an agent provider, which a host would never run', () => {
    assert.throws(() => automationDefinition(automation({ agent: undefined as never }), workspace()), /agent.provider is required/);
  });

  it('refuses a schedule that is not five cron fields', () => {
    assert.throws(() => automationDefinition(automation({ trigger: { schedule: '@daily' } }), workspace()), /five cron fields/);
  });
});

describe('reconcileAutomations', () => {
  const ready = (pod: string): WorkspaceHostStatus => ({ pod, hostSet: 'fred', phase: 'Ready', message: null, podUID: `uid-${pod}`, repository: null, since: null });

  async function setup(pods: string[]) {
    const fakes = new Map(pods.map((p) => [p, new FakeHost()]));
    const connections = new Map<string, AgentHost>();
    for (const [pod, fake] of fakes) connections.set(pod, await connect(fake));
    const world = new World([set('fred', pods.map((p) => host(p)))], connections);
    return { fakes, world };
  }

  it('creates it on the lowest ready host holding its workspace, and reports its next run', async () => {
    const { kube, lastStatus } = fakeKube();
    const { fakes, world } = await setup(['p-0', 'p-1']);
    await reconcileAutomations(deps(kube), [automation()], [workspace()], new Map([['my-app', [ready('p-1'), ready('p-0')]]]), world);
    assert.deepEqual([...fakes.get('p-0')!.catalog.keys()], ['ahp-automation:/k8s-deps']);
    assert.equal(fakes.get('p-1')!.catalog.size, 0);
    const status = lastStatus('deps');
    assert.equal(status.phase, 'Ready');
    assert.deepEqual(status.hosts, [{ pod: 'p-0', resource: 'ahp-automation:/k8s-deps', nextRunAt: '2026-11-27T03:00:00.000Z', lastRun: null }]);
  });

  it('EachHost: on every host', async () => {
    const { kube } = fakeKube();
    const { fakes, world } = await setup(['p-0', 'p-1']);
    await reconcileAutomations(deps(kube), [automation({ placement: 'EachHost' })], [workspace()], new Map([['my-app', [ready('p-0'), ready('p-1')]]]), world);
    assert.equal(fakes.get('p-0')!.catalog.size + fakes.get('p-1')!.catalog.size, 2);
  });

  it('turns on automations on a host it puts an enabled automation on, and only then', async () => {
    const { kube } = fakeKube();
    const { fakes, world } = await setup(['p-0', 'p-1']);
    const placed = new Map([['my-app', [ready('p-0'), ready('p-1')]]]);
    await reconcileAutomations(deps(kube), [automation({ enabled: false, placement: 'EachHost' })], [workspace()], placed, world);
    assert.deepEqual([fakes.get('p-0')!.automationsEnabled, fakes.get('p-1')!.automationsEnabled], [false, false]);
    await reconcileAutomations(deps(kube), [automation()], [workspace()], placed, world);
    assert.deepEqual([fakes.get('p-0')!.automationsEnabled, fakes.get('p-1')!.automationsEnabled], [true, false]);
    const changes = () => fakes.get('p-0')!.received.filter((r) => r.params?.action?.type === 'root/configChanged').length;
    await reconcileAutomations(deps(kube), [automation()], [workspace()], placed, world);
    assert.equal(changes(), 1, 'once');
  });

  it('says why it cannot remove an automation while a run is in progress', async () => {
    const { kube, lastStatus } = fakeKube();
    const { fakes, world } = await setup(['p-0']);
    const placed = new Map([['my-app', [ready('p-0')]]]);
    await reconcileAutomations(deps(kube), [automation()], [workspace()], placed, world);
    const entry = fakes.get('p-0')!.catalog.get('ahp-automation:/k8s-deps')!;
    // As the host has it mid-run: no remove operation.
    fakes.get('p-0')!.catalog.set(entry.resource, { ...entry, operations: ['update'] as never, runs: [{ lifecycle: { status: 'running' } }] as never });
    const status = { hosts: [{ pod: 'p-0', resource: entry.resource, nextRunAt: null, lastRun: null }] };
    const host = world.agentHost('p-0')!;
    // The client sees the catalogue through its mirror: resubscribe it.
    (host as any).automationCatalog = async () => [fakes.get('p-0')!.catalog.get(entry.resource)!];
    await reconcileAutomations(deps(kube), [automation({}, { deletionTimestamp: NOW.toISOString() }, status)], [workspace()], placed, world);
    assert.match(lastStatus('deps').message, /a run is in progress/);
  });

  it('updates it when the spec changes, and leaves it alone when not', async () => {
    const { kube } = fakeKube();
    const { fakes, world } = await setup(['p-0']);
    const placed = new Map([['my-app', [ready('p-0')]]]);
    await reconcileAutomations(deps(kube), [automation()], [workspace()], placed, world);
    const updates = () => fakes.get('p-0')!.received.filter((r) => r.params?.action?.type === 'automation/updateRequested').length;
    await reconcileAutomations(deps(kube), [automation()], [workspace()], placed, world);
    assert.equal(updates(), 0);
    await reconcileAutomations(deps(kube), [automation({ prompt: 'Something else.' })], [workspace()], placed, world);
    assert.equal(updates(), 1);
    assert.equal((fakes.get('p-0')!.catalog.get('ahp-automation:/k8s-deps')!.definition.message as any).text, 'Something else.');
  });

  it('removes it when deleted, then drops its finalizer', async () => {
    const { kube, calls } = fakeKube();
    const { fakes, world } = await setup(['p-0']);
    const placed = new Map([['my-app', [ready('p-0')]]]);
    await reconcileAutomations(deps(kube), [automation()], [workspace()], placed, world);
    const status = { hosts: [{ pod: 'p-0', resource: 'ahp-automation:/k8s-deps', nextRunAt: null, lastRun: null }] };
    await reconcileAutomations(deps(kube), [automation({}, { deletionTimestamp: NOW.toISOString() }, status)], [workspace()], placed, world);
    assert.equal(fakes.get('p-0')!.catalog.size, 0);
    assert.deepEqual(calls.patches.at(-1)?.body.metadata.finalizers, []);
  });

  it('keeps the finalizer while a host that holds it cannot be reached', async () => {
    const { kube, calls, lastStatus } = fakeKube();
    const world = new World([set('fred', [host('p-0')])], new Map([['p-0', new Error('down')]]));
    const status = { hosts: [{ pod: 'p-0', resource: 'ahp-automation:/k8s-deps', nextRunAt: null, lastRun: null }] };
    await reconcileAutomations(deps(kube), [automation({}, { deletionTimestamp: NOW.toISOString() }, status)], [workspace()], new Map(), world);
    assert.equal(calls.patches.length, 0);
    assert.equal(lastStatus('deps').phase, 'Deleting');
  });

  it('removes automations of its own that nothing asks for, and leaves others', async () => {
    const { kube } = fakeKube();
    const { fakes, world } = await setup(['p-0']);
    const fake = fakes.get('p-0')!;
    const def = automationDefinition(automation({}, { name: 'gone' }), workspace());
    fake.catalog.set('ahp-automation:/k8s-gone', fake.entry('ahp-automation:/k8s-gone', def));
    fake.catalog.set('ahp-automation:/mine', fake.entry('ahp-automation:/mine', { ...def, _meta: {} }));
    // A fresh connection, so its snapshot has both.
    const world2 = new World(world.sets, new Map([['p-0', await connect(fake)]]));
    await reconcileAutomations(deps(kube), [], [workspace()], new Map(), world2);
    assert.deepEqual([...fake.catalog.keys()], ['ahp-automation:/mine']);
  });

  it('waits for its workspace, and says when it is missing', async () => {
    const { kube, lastStatus } = fakeKube();
    const { world } = await setup(['p-0']);
    await reconcileAutomations(deps(kube), [automation()], [workspace()], new Map([['my-app', [{ ...ready('p-0'), phase: 'Cloning' as const }]]]), world);
    assert.deepEqual([lastStatus('deps').phase, lastStatus('deps').message], ['Waiting', 'waiting for workspace my-app on a host']);
    await reconcileAutomations(deps(kube), [automation({ workspace: 'other' })], [workspace()], new Map(), world);
    assert.deepEqual([lastStatus('deps').phase, lastStatus('deps').message], ['Waiting', 'AgentWorkspace other not found']);
  });
});

describe('reconcileHostSet', () => {
  const hostSet: HostSetResource = {
    metadata: { name: 'fred', generation: 1 },
    spec: { statefulSet: 'agents-fred', connectionToken: { secretName: 't' }, address: 'wss://{pod}.example.ts.net' },
  };

  it('opens the gate once the workspaces are in place, and reports each host', async () => {
    const { kube, calls, lastStatus } = fakeKube();
    const agentHost = await connect(new FakeHost({ agents: ['copilot', 'claude'] }));
    const placedSet = set('fred', [host('agents-fred-0', { contentReady: false })]);
    const world = new World([placedSet], new Map([['agents-fred-0', agentHost]]));
    await reconcileHostSet(deps(kube), hostSet, placedSet, world, new Map([['agents-fred-0', [{ workspace: 'my-app', phase: 'Ready' as const, since: null }]]]));
    assert.deepEqual(calls.gates, [{ pod: 'agents-fred-0', ready: true, message: '1 workspace(s) in place' }]);
    assert.deepEqual(lastStatus('fred'), {
      observedGeneration: 1,
      phase: 'Ready',
      message: null,
      hosts: [
        {
          pod: 'agents-fred-0',
          phase: 'Ready',
          address: 'wss://agents-fred-0.example.ts.net',
          protocolVersion: '1.1.0',
          serverInfo: 'fake-host 0.0.1',
          agents: ['claude', 'copilot'],
          contentReady: true,
          workspaces: [{ name: 'my-app', phase: 'Ready' }],
          message: null,
        },
      ],
    });
  });

  it('holds the gate while a workspace is cloning, and is Degraded on a failed one', async () => {
    const { kube, calls, lastStatus } = fakeKube();
    const agentHost = await connect(new FakeHost());
    const placedSet = set('fred', [host('p-0'), host('p-1')]);
    const world = new World([placedSet], new Map([['p-0', agentHost], ['p-1', agentHost]]));
    await reconcileHostSet(
      deps(kube),
      hostSet,
      placedSet,
      world,
      new Map([
        ['p-0', [{ workspace: 'my-app', phase: 'Cloning' as const, since: NOW.toISOString() }]],
        ['p-1', [{ workspace: 'my-app', phase: 'Error' as const, since: null }]],
      ]),
    );
    assert.deepEqual(calls.gates.map((g) => [g.pod, g.ready]), [['p-0', false], ['p-1', true]]);
    assert.deepEqual(lastStatus('fred').hosts.map((h: any) => [h.pod, h.phase]), [['p-0', 'Pending'], ['p-1', 'Degraded']]);
    assert.equal(lastStatus('fred').phase, 'Degraded');
  });

  it('is Error when its StatefulSet is missing, or a host cannot be reached', async () => {
    const { kube, lastStatus } = fakeKube();
    await reconcileHostSet(deps(kube), hostSet, set('fred', null), new World([]), new Map());
    assert.deepEqual([lastStatus('fred').phase, lastStatus('fred').message], ['Error', 'StatefulSet agents-fred not found']);
    const placedSet = set('fred', [host('p-0', { contentReady: true })]);
    await reconcileHostSet(deps(kube), hostSet, placedSet, new World([placedSet], new Map([['p-0', new Error('connecting: refused')]])), new Map());
    assert.deepEqual(lastStatus('fred').hosts.map((h: any) => [h.phase, h.message]), [['Error', 'connecting: refused']]);
  });

  it('skips writing an unchanged status', async () => {
    const { kube, calls } = fakeKube();
    await reconcileHostSet(deps(kube), { ...hostSet, status: { phase: 'Error', message: 'StatefulSet agents-fred not found', hosts: [], observedGeneration: 1 } as any }, set('fred', null), new World([]), new Map());
    assert.equal(calls.statuses.length, 0);
  });
});

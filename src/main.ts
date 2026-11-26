// VS Code agent host operator: clones AgentWorkspace resources onto the agent
// hosts of the AgentHostSets they select, gates each host's readiness on its
// workspaces, and keeps AgentAutomation resources in the hosts' automation
// catalogues.
//
// A pass reads everything and reconciles everything. Passes run when a watch
// sees an AgentHostSet, AgentWorkspace, AgentAutomation or pod change
// (watch.ts), when a clone ends, and on a timer for what no watch can see,
// inside the hosts: every CLONING_POLL_SECONDS while a clone is under way,
// else every RESYNC_INTERVAL_SECONDS.
// Run with Node's built-in type stripping: `node src/main.ts`.

import { randomUUID } from 'node:crypto';
import { connectHost, hostUrl, type AgentHost } from './ahp.ts';
import { Clones } from './clones.ts';
import { Connections } from './connections.ts';
import { GROUP, VERSION, makeKube } from './kube.ts';
import {
  PLURALS,
  World,
  errorMessage,
  reconcileAutomations,
  reconcileHostSet,
  reconcileWorkspace,
  type AutomationResource,
  type HostSetResource,
  type Placed,
  type PlacedSet,
  type WorkspaceHostStatus,
  type WorkspaceResource,
} from './reconcile.ts';
import { Trigger, watch } from './watch.ts';

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
};

const namespace = required('NAMESPACE');
const resyncMs = Number(process.env.RESYNC_INTERVAL_SECONDS ?? '300') * 1000;
const cloningPollMs = Number(process.env.CLONING_POLL_SECONDS ?? '5') * 1000;
export const DEFAULT_PORT = 8081;

const log = (level: string, message: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), level, message, ...fields }));

const kube = makeKube(namespace);
const trigger = new Trigger();
// One AHP client id per operator process: the hosts tell our dispatches
// apart by it.
const clientId = `agent-host-operator-${randomUUID()}`;
const connections = new Connections({ connect: (url) => connectHost(url, { clientId }) });
// The clones, which outlive a pass. One that ends runs a pass, which records it.
const clones = new Clones({ exec: kube.exec, onEnd: () => trigger.notify() });

async function pass(): Promise<boolean> {
  const deps = { kube, clones, now: () => new Date() };
  const setResources = await kube.list<HostSetResource>(PLURALS.hostSets);
  const sets: PlacedSet[] = [];
  const connected = new Map<string, AgentHost | Error>();
  for (const set of setResources) {
    const hosts = await kube.statefulSetHosts(set.spec.statefulSet);
    const { secretName, key = 'token' } = set.spec.connectionToken ?? {};
    let token: string | null = null;
    let error: string | null = null;
    try {
      token = secretName ? await kube.secretValue(secretName, key) : null;
      if (token === null) error = secretName ? `no connection token: Secret ${secretName} has no key ${key}` : 'spec.connectionToken.secretName is not set';
    } catch (e) {
      error = `reading Secret ${secretName}: ${errorMessage(e)}`;
    }
    sets.push({ name: set.metadata.name, labels: set.metadata.labels ?? {}, spec: set.spec, hosts, error });
    for (const host of hosts ?? []) {
      if (!host.ready || !host.ip) continue;
      if (token === null) {
        connected.set(host.name, new Error(error ?? 'no connection token'));
        continue;
      }
      try {
        connected.set(host.name, await connections.get(host.name, { uid: host.uid, url: hostUrl(host.ip, set.spec.port ?? DEFAULT_PORT, token) }));
      } catch (e) {
        connected.set(host.name, e instanceof Error ? e : new Error(String(e)));
      }
    }
  }
  const pods = new Set(sets.flatMap((s) => (s.hosts ?? []).map((h) => h.name)));
  connections.retain(new Set(connected.keys()));
  clones.retain(pods);
  const world = new World(sets, connected);

  // pod -> the workspaces placed there, for the readiness gates; workspace
  // -> where it stands on each host, for the automations.
  const placed = new Map<string, Placed[]>();
  const byWorkspace = new Map<string, ReadonlyArray<WorkspaceHostStatus>>();
  const workspaces = await kube.list<WorkspaceResource>(PLURALS.workspaces);
  for (const workspace of workspaces) {
    let statuses: ReadonlyArray<WorkspaceHostStatus>;
    try {
      statuses = await reconcileWorkspace(deps, workspace, world);
    } catch (error) {
      log('error', 'AgentWorkspace reconcile failed', { name: workspace.metadata.name, error: errorMessage(error) });
      statuses = workspace.status?.hosts ?? [];
    }
    byWorkspace.set(workspace.metadata.name, statuses);
    for (const status of statuses) {
      const entry = { workspace: workspace.metadata.name, phase: status.phase, since: status.phase === 'Cloning' ? status.since : null };
      placed.set(status.pod, [...(placed.get(status.pod) ?? []), entry]);
    }
  }

  try {
    await reconcileAutomations(deps, await kube.list<AutomationResource>(PLURALS.automations), workspaces, byWorkspace, world);
  } catch (error) {
    log('error', 'AgentAutomation reconcile failed', { error: errorMessage(error) });
  }

  for (const [i, set] of setResources.entries()) {
    try {
      await reconcileHostSet(deps, set, sets[i]!, world, placed);
    } catch (error) {
      log('error', 'AgentHostSet reconcile failed', { name: set.metadata.name, error: errorMessage(error) });
    }
  }
  return clones.running();
}

const stop = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => stop.abort());

const custom = `/apis/${GROUP}/${VERSION}/namespaces/${namespace}`;
const watched = [
  `${custom}/${PLURALS.hostSets}`,
  `${custom}/${PLURALS.workspaces}`,
  `${custom}/${PLURALS.automations}`,
  // Every pod in the namespace: new hosts, readiness, scaling. StatefulSet
  // changes all show up here, so they need no watch of their own. Pods of
  // no set only cost a pass that changes nothing.
  `/api/v1/namespaces/${namespace}/pods`,
];
const watches = watched.map((path) =>
  watch({
    get: kube.get,
    path,
    onChange: () => trigger.notify(),
    signal: stop.signal,
    log: (message, fields) => log('warn', message, fields),
  }),
);

log('info', 'started', { namespace, clientId, resyncSeconds: resyncMs / 1000, cloningPollSeconds: cloningPollMs / 1000 });
let cloning = false;
while (!stop.signal.aborted) {
  try {
    cloning = await pass();
  } catch (error) {
    log('error', 'reconcile pass failed', { error: errorMessage(error) });
  }
  await trigger.wait(cloning ? cloningPollMs : resyncMs, stop.signal);
}
connections.closeAll();
await Promise.allSettled(watches);
log('info', 'stopped');

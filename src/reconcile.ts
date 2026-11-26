// Level-triggered reconciliation. A host is one agent host pod; a host set
// is the StatefulSet that makes a group of them. An AgentWorkspace selects
// sets by label and is cloned onto every host of every set it selects; an
// AgentAutomation is placed on one, or each, of the hosts that hold its
// workspace. The host runs the automation: the operator only decides which
// hosts hold its definition. See docs/design.md.

import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { AutomationDefinition, AutomationEntry } from '@microsoft/agent-host-protocol';
import { fileUri, type AgentHost } from './ahp.ts';
import type { Clones } from './clones.ts';
import type { Host, Kube, Resource } from './kube.ts';
import { GROUP } from './kube.ts';
import { matches, type LabelSelector } from './selector.ts';

export const FINALIZER = `${GROUP}/cleanup`;
// Marks an automation in a host's catalogue as the operator's: the
// AgentAutomation it comes from, and the hash of the definition it applied.
export const OWNER_META = `${GROUP}/automation`;
export const HASH_META = `${GROUP}/hash`;
export const AUTOMATION_PREFIX = 'ahp-automation:/k8s-';
// A clone holds the readiness gate this long at most. One that fails turns
// Error, which doesn't hold it; this bounds one that never finishes.
export const CLONE_GATE_MS = 15 * 60 * 1000;
// A clone that failed is tried again, from the same repository, this long
// after it failed: a network outage, or a key not yet in place, passes.
export const CLONE_RETRY_MS = 5 * 60 * 1000;

export const PLURALS = {
  hostSets: 'agenthostsets',
  workspaces: 'agentworkspaces',
  automations: 'agentautomations',
} as const;

// ─── resources ───────────────────────────────────────────────────────────────

export interface HostSetSpec {
  readonly statefulSet: string;
  // For exec (clones). Default: the pod's first container.
  readonly container?: string;
  // The host's WebSocket port. Default 8081.
  readonly port?: number;
  // The Secret the pods mount as --connection-token-file.
  readonly connectionToken: { readonly secretName: string; readonly key?: string };
  // Reported in status, for clients; {pod} is the pod's name.
  readonly address?: string;
}

export type HostPhase = 'Pending' | 'Ready' | 'Degraded' | 'Error';

// Status lists rather than maps: a merge patch replaces a list whole, so an
// entry dropped here is gone, where a dropped map key would linger.
export interface HostStatus {
  readonly pod: string;
  readonly phase: HostPhase;
  readonly address: string | null;
  readonly protocolVersion: string | null;
  readonly serverInfo: string | null;
  readonly agents: ReadonlyArray<string>;
  readonly contentReady: boolean;
  readonly workspaces: ReadonlyArray<{ readonly name: string; readonly phase: WorkspacePhase }>;
  readonly message: string | null;
}

export type HostSetResource = Resource<
  HostSetSpec,
  { readonly phase?: string; readonly message?: string | null; readonly hosts?: ReadonlyArray<HostStatus> }
>;

export interface WorkspaceSpec {
  readonly repository: string;
  // The branch to check out. Default: the remote's default.
  readonly ref?: string;
  // Default /workspace/<name>.
  readonly path?: string;
  readonly hostSetSelector?: LabelSelector;
  // Retain (default): the folder stays when the workspace goes. Delete
  // removes it.
  readonly deletionPolicy?: 'Retain' | 'Delete';
}

export type WorkspacePhase = 'Waiting' | 'Cloning' | 'Ready' | 'Error';

export interface WorkspaceHostStatus {
  readonly pod: string;
  readonly hostSet: string;
  readonly phase: WorkspacePhase;
  readonly message: string | null;
  readonly podUID: string | null;
  // The repository the checkout came from; null for files the operator
  // found there.
  readonly repository: string | null;
  // Cloning: since when. Error: when the clone failed.
  readonly since: string | null;
}

export type WorkspaceResource = Resource<
  WorkspaceSpec,
  {
    readonly observedGeneration?: number | null;
    readonly phase?: string;
    readonly message?: string | null;
    readonly hosts?: ReadonlyArray<WorkspaceHostStatus>;
  }
>;

export type Placement = 'One' | 'EachHost';

export interface AutomationSpec {
  // An AgentWorkspace: the session's working directory, and where it goes.
  readonly workspace: string;
  readonly prompt: string;
  // Default: the resource's name.
  readonly title?: string;
  readonly enabled?: boolean;
  // No trigger, or no schedule: manual runs only.
  readonly trigger?: {
    // Five-field cron, as AHP defines it.
    readonly schedule?: string;
    // IANA time zone. Default UTC.
    readonly timeZone?: string;
    readonly misfirePolicy?: 'skip' | 'runOnce';
  };
  readonly agent?: {
    // claude | copilot | codex, as the host names its agents. Default: the
    // host's default.
    readonly provider?: string;
    readonly model?: string;
    readonly modelConfig?: Readonly<Record<string, string | number | boolean>>;
  };
  // Session configuration values (the session's config schema, such as its
  // permission mode), passed to the host as they are.
  readonly config?: Readonly<Record<string, unknown>>;
  readonly placement?: Placement;
}

export interface AutomationHostStatus {
  readonly pod: string;
  readonly resource: string;
  readonly nextRunAt: string | null;
  readonly lastRun: { readonly status: string; readonly createdAt: string; readonly completedAt: string | null; readonly error: string | null } | null;
}

export type AutomationResource = Resource<
  AutomationSpec,
  {
    readonly observedGeneration?: number | null;
    readonly phase?: string;
    readonly message?: string | null;
    readonly hosts?: ReadonlyArray<AutomationHostStatus>;
  }
>;

// ─── what a pass observed ────────────────────────────────────────────────────

export interface PlacedSet {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly spec: HostSetSpec;
  // null when the StatefulSet is missing.
  readonly hosts: ReadonlyArray<Host> | null;
  // Why no host of the set can be connected to (its token is missing).
  readonly error?: string | null;
}

export class World {
  readonly sets: ReadonlyArray<PlacedSet>;
  readonly #hosts = new Map<string, { readonly host: Host; readonly set: PlacedSet }>();
  readonly #connections: ReadonlyMap<string, AgentHost | Error>;

  // `connections`: for each host that is up, its connection or why there is
  // none.
  constructor(sets: ReadonlyArray<PlacedSet>, connections: ReadonlyMap<string, AgentHost | Error> = new Map()) {
    this.sets = sets;
    this.#connections = connections;
    for (const set of sets) for (const host of set.hosts ?? []) this.#hosts.set(host.name, { host, set });
  }
  host(pod: string): Host | undefined {
    return this.#hosts.get(pod)?.host;
  }
  setOf(pod: string): PlacedSet | undefined {
    return this.#hosts.get(pod)?.set;
  }
  labelsOf(set: string) {
    return this.sets.find((s) => s.name === set)?.labels ?? {};
  }
  // The connection to a host that is up; undefined when there is none.
  agentHost(pod: string): AgentHost | undefined {
    const c = this.#connections.get(pod);
    return c instanceof Error ? undefined : c;
  }
  connectionError(pod: string): string | null {
    const c = this.#connections.get(pod);
    return c instanceof Error ? c.message : null;
  }
  // Every connected host.
  connected(): ReadonlyArray<string> {
    return [...this.#connections.entries()].filter(([, c]) => !(c instanceof Error)).map(([pod]) => pod).sort(byName);
  }
}

export interface Deps {
  readonly kube: Kube;
  readonly clones: Clones;
  readonly now: () => Date;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex').slice(0, 16);
export const byName = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
export const workspacePath = (cr: WorkspaceResource) => posix.normalize(cr.spec.path ?? `/workspace/${cr.metadata.name}`);
export const automationResource = (name: string) => `${AUTOMATION_PREFIX}${name}`;

export function aggregatePhase(phases: ReadonlyArray<string>): string {
  if (phases.length === 0) return 'Waiting';
  if (phases.includes('Error')) return 'Error';
  if (phases.every((phase) => phase === 'Ready')) return 'Ready';
  return 'Progressing';
}

// Where an automation goes. `candidates` are the hosts it may be on,
// `eligible` those of them ready for it now, `holding` those that have it
// already. A host that holds it keeps it while it is a candidate, ready or
// not: moving it restarts its schedule elsewhere, which a pod restart must
// not cause. One: the lowest ordinal.
export function choosePlacement(
  placement: Placement | undefined,
  candidates: ReadonlyArray<string>,
  eligible: ReadonlyArray<string>,
  holding: ReadonlyArray<string>,
): string[] {
  const kept = holding.filter((n) => candidates.includes(n)).sort(byName);
  if ((placement ?? 'One') === 'One') {
    return kept.length > 0 ? [kept[0]!] : eligible.length > 0 ? [[...eligible].sort(byName)[0]!] : [];
  }
  return [...new Set([...eligible, ...kept])].sort(byName);
}

// Status as the API server hands it back: object keys sorted (it is a Go map
// there), and null fields gone (a merge patch deletes them). Inside arrays,
// which a merge patch replaces whole, nulls survive.
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v === null ? null : canonical(v)));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((k) => (value as any)[k] !== null && (value as any)[k] !== undefined)
      .map((k) => [k, canonical((value as any)[k])]),
  );
}

export async function writeStatus(deps: Deps, plural: string, cr: Resource<unknown, any>, status: Record<string, unknown>) {
  const next = { observedGeneration: cr.metadata.generation ?? null, ...status };
  // Unchanged: skip the write. Not just to save API calls: the operator
  // watches its own resources, so every write is another pass.
  if (JSON.stringify(canonical(next)) === JSON.stringify(canonical(cr.status ?? {}))) return;
  await deps.kube.patchStatus(plural, cr.metadata.name, next);
}

export async function addFinalizer(deps: Deps, cr: Resource<unknown, unknown>, plural: string) {
  if (cr.metadata.finalizers?.includes(FINALIZER)) return;
  await deps.kube.patch(plural, cr.metadata.name, {
    metadata: { resourceVersion: cr.metadata.resourceVersion, finalizers: [...(cr.metadata.finalizers ?? []), FINALIZER] },
  });
}

export async function removeFinalizer(deps: Deps, cr: Resource<unknown, unknown>, plural: string) {
  await deps.kube.patch(plural, cr.metadata.name, {
    metadata: {
      resourceVersion: cr.metadata.resourceVersion,
      finalizers: (cr.metadata.finalizers ?? []).filter((f) => f !== FINALIZER),
    },
  });
}

// ─── AgentWorkspace ──────────────────────────────────────────────────────────

const containerOf = (set: PlacedSet | undefined, host: Host) => set?.spec.container ?? host.containers[0] ?? 'agent-host';

// The workspace on one host that is up and connected. A workspace is there
// once its folder holds files: a clone that finished, or files that were
// there already (a restarted pod, or a checkout made by hand), which are kept
// as they are. A failed clone is retried after CLONE_RETRY_MS, or at once for
// a changed repository or ref, or a restarted pod.
async function syncWorkspace(
  deps: Deps,
  cr: WorkspaceResource,
  host: Host,
  agentHost: AgentHost,
  set: PlacedSet,
  previous: WorkspaceHostStatus | undefined,
): Promise<WorkspaceHostStatus> {
  const now = deps.now();
  const path = workspacePath(cr);
  const ref = cr.spec.ref ?? null;
  const status = (fields: Pick<WorkspaceHostStatus, 'phase' | 'message' | 'repository' | 'since'>): WorkspaceHostStatus => ({
    pod: host.name,
    hostSet: set.name,
    podUID: host.uid,
    ...fields,
  });
  const ready = (repository: string | null, message: string | null) => status({ phase: 'Ready', message, repository, since: null });

  if (previous?.phase === 'Ready' && previous.podUID === host.uid) {
    // A changed repository doesn't replace a checkout: its files stay.
    const message =
      previous.repository !== null && previous.repository !== cr.spec.repository
        ? `checked out from ${previous.repository}; a changed repository is not cloned again`
        : previous.message;
    return ready(previous.repository, message);
  }

  let job = deps.clones.get(host.name, path);
  if (job && job.podUID !== host.uid) {
    deps.clones.forget(host.name, path);
    job = undefined;
  }
  if (job?.phase === 'running') {
    return status({ phase: 'Cloning', message: `cloning ${job.repository} into ${path}`, repository: job.repository, since: job.startedAt });
  }
  if (job?.phase === 'done') {
    // Recorded in status from here on; a later pod checks its folder anew.
    deps.clones.forget(host.name, path);
    return job.existing ? ready(previous?.repository ?? null, `kept the files already in ${path}`) : ready(job.repository, null);
  }
  if (job?.phase === 'failed') {
    const changed = job.repository !== cr.spec.repository || job.ref !== ref;
    const due = now.getTime() - Date.parse(job.endedAt ?? '') >= CLONE_RETRY_MS;
    if (!changed && !due) {
      return status({
        phase: 'Error',
        message: `clone of ${job.repository} into ${path} failed: ${job.error ?? 'no detail'}`,
        repository: job.repository,
        since: job.endedAt,
      });
    }
    deps.clones.forget(host.name, path);
  }

  // No clone of ours under way: are there files already?
  const entries = await agentHost.list(path);
  if (entries !== null && entries.length > 0) {
    return ready(previous?.repository ?? null, previous?.phase === 'Ready' ? previous.message : `kept the files already in ${path}`);
  }
  job = await deps.clones.start({
    host: host.name,
    podUID: host.uid,
    container: containerOf(set, host),
    path,
    repository: cr.spec.repository,
    ref,
  });
  if (job.phase === 'running') {
    return status({ phase: 'Cloning', message: `cloning ${job.repository} into ${path}`, repository: job.repository, since: job.startedAt });
  }
  if (job.phase === 'done') {
    deps.clones.forget(host.name, path);
    return job.existing ? ready(null, `kept the files already in ${path}`) : ready(job.repository, null);
  }
  return status({
    phase: 'Error',
    message: `clone of ${job.repository} into ${path} failed: ${job.error ?? 'no detail'}`,
    repository: job.repository,
    since: job.endedAt,
  });
}

// Takes the workspace off one host, per deletionPolicy.
async function removeWorkspace(cr: WorkspaceResource, agentHost: AgentHost) {
  if ((cr.spec.deletionPolicy ?? 'Retain') !== 'Delete') return;
  await agentHost.remove(workspacePath(cr));
}

// Returns the workspace's status on the hosts it targets, for the host
// sets' readiness gates and the automations.
export async function reconcileWorkspace(deps: Deps, cr: WorkspaceResource, world: World): Promise<ReadonlyArray<WorkspaceHostStatus>> {
  const plural = PLURALS.workspaces;
  const previous = new Map((cr.status?.hosts ?? []).map((e) => [e.pod, e]));
  const path = workspacePath(cr);

  if (cr.metadata.deletionTimestamp) {
    if (!cr.metadata.finalizers?.includes(FINALIZER)) return [];
    const pending: WorkspaceHostStatus[] = [];
    for (const status of previous.values()) {
      const host = world.host(status.pod);
      deps.clones.forget(status.pod, path);
      if (!host) continue; // scaled away, or its set removed: nothing to clean up
      if ((cr.spec.deletionPolicy ?? 'Retain') === 'Retain') continue;
      const agentHost = world.agentHost(status.pod);
      if (!host.ready || !agentHost) {
        pending.push({ ...status, phase: 'Waiting', message: 'host not reachable; removal waits for it' });
        continue;
      }
      try {
        await removeWorkspace(cr, agentHost);
      } catch (error) {
        pending.push({ ...status, phase: 'Error', message: `removal failed: ${errorMessage(error)}` });
      }
    }
    if (pending.length > 0) {
      await writeStatus(deps, plural, cr, { phase: 'Deleting', message: null, hosts: pending });
    } else {
      await removeFinalizer(deps, cr, plural);
    }
    return [];
  }

  await addFinalizer(deps, cr, plural);
  const targets = world.sets
    .filter((set) => matches(cr.spec.hostSetSelector, set.labels))
    .flatMap((set) => (set.hosts ?? []).map((host) => ({ host, set })));
  const targeted = new Set(targets.map((t) => t.host.name));

  const entries = new Map<string, WorkspaceHostStatus>();
  const blank = (pod: string, hostSet: string): WorkspaceHostStatus => ({
    pod,
    hostSet,
    phase: 'Waiting',
    message: null,
    podUID: null,
    repository: null,
    since: null,
  });
  for (const { host, set } of targets) {
    const before = previous.get(host.name);
    if (!host.ready) {
      entries.set(host.name, { ...(before ?? blank(host.name, set.name)), hostSet: set.name, phase: 'Waiting', message: 'pod not ready' });
      continue;
    }
    const agentHost = world.agentHost(host.name);
    if (!agentHost) {
      // Up, but not reachable over AHP: an Error for a person to see, which
      // doesn't hold the readiness gate.
      entries.set(host.name, {
        ...(before ?? blank(host.name, set.name)),
        hostSet: set.name,
        phase: 'Error',
        message: `no connection to the host: ${world.connectionError(host.name) ?? 'unknown'}`,
      });
      continue;
    }
    try {
      entries.set(host.name, await syncWorkspace(deps, cr, host, agentHost, set, before));
    } catch (error) {
      entries.set(host.name, {
        ...(before ?? blank(host.name, set.name)),
        hostSet: set.name,
        podUID: host.uid,
        phase: 'Error',
        message: errorMessage(error),
      });
    }
  }

  // Hosts the selector no longer reaches lose the workspace. One whose pod
  // is gone (scaled away) is simply forgotten: its volumes, and the folder on
  // them, come back with it.
  for (const status of previous.values()) {
    if (targeted.has(status.pod)) continue;
    deps.clones.forget(status.pod, path);
    const host = world.host(status.pod);
    if (!host || (cr.spec.deletionPolicy ?? 'Retain') === 'Retain') continue;
    const agentHost = world.agentHost(status.pod);
    if (!host.ready || !agentHost) {
      entries.set(status.pod, { ...status, phase: 'Waiting', message: 'no longer selected; removal waits for the host' });
      continue;
    }
    try {
      await removeWorkspace(cr, agentHost);
    } catch (error) {
      entries.set(status.pod, { ...status, phase: 'Error', message: `removal failed: ${errorMessage(error)}` });
    }
  }

  const hosts = [...entries.values()].sort((a, b) => byName(a.pod, b.pod));
  const current = hosts.filter((e) => targeted.has(e.pod));
  await writeStatus(deps, plural, cr, {
    phase: aggregatePhase(current.map((e) => e.phase)),
    message: targets.length === 0 ? 'no host set matches hostSetSelector' : null,
    hosts,
  });
  return current;
}

// ─── AgentAutomation ─────────────────────────────────────────────────────────

const CRON_FIELD = /^[A-Za-z0-9*,/-]+$/;

// The definition the host stores for an automation, with the hash of
// everything but the hash in its _meta.
export function automationDefinition(cr: AutomationResource, workspace: WorkspaceResource): AutomationDefinition {
  const { spec } = cr;
  const schedule = spec.trigger?.schedule?.trim();
  if (schedule !== undefined && schedule !== '') {
    const fields = schedule.split(/\s+/);
    if (fields.length !== 5 || !fields.every((f) => CRON_FIELD.test(f))) {
      throw new Error(`trigger.schedule ${JSON.stringify(schedule)}: expected five cron fields, such as "0 3 * * 1-5"`);
    }
  }
  const model = spec.agent?.model
    ? { id: spec.agent.model, ...(spec.agent.modelConfig ? { config: { ...spec.agent.modelConfig } } : {}) }
    : undefined;
  const body = {
    title: spec.title ?? cr.metadata.name,
    message: { text: spec.prompt, origin: { kind: 'automation' } },
    session: {
      ...(spec.agent?.provider ? { provider: spec.agent.provider } : {}),
      ...(model ? { model } : {}),
      workingDirectories: [fileUri(workspacePath(workspace))],
      ...(spec.config ? { config: { ...spec.config } } : {}),
    },
    enabled: spec.enabled ?? true,
    triggers: schedule
      ? [
          {
            id: 'schedule',
            kind: 'schedule',
            schedule: { expression: schedule, timeZone: spec.trigger?.timeZone ?? 'UTC' },
            ...(spec.trigger?.misfirePolicy ? { misfirePolicy: spec.trigger.misfirePolicy } : {}),
          },
        ]
      : [],
  };
  return { ...body, _meta: { [OWNER_META]: cr.metadata.name, [HASH_META]: hash(body) } } as unknown as AutomationDefinition;
}

// The AgentAutomation a catalogue entry belongs to, if it is the operator's.
export function ownerOf(entry: AutomationEntry): string | null {
  const owner = entry.definition._meta?.[OWNER_META];
  if (typeof owner === 'string') return owner;
  return entry.resource.startsWith(AUTOMATION_PREFIX) ? entry.resource.slice(AUTOMATION_PREFIX.length) : null;
}

const lastRunOf = (entry: AutomationEntry | undefined): AutomationHostStatus['lastRun'] => {
  const run = entry?.runs?.[0];
  if (!run) return null;
  const lifecycle = run.lifecycle as { status: string; createdAt: string; completedAt?: string; error?: { message?: string } };
  return {
    status: lifecycle.status,
    createdAt: lifecycle.createdAt,
    completedAt: lifecycle.completedAt ?? null,
    error: lifecycle.error?.message ?? null,
  };
};

// Places every automation on its hosts, and takes it off the hosts it no
// longer belongs on: for each connected host, the automations the operator
// wants there are compared with the operator's ones in its catalogue.
// Automations are reconciled together because one host's catalogue serves
// all of them.
export async function reconcileAutomations(
  deps: Deps,
  automations: ReadonlyArray<AutomationResource>,
  workspaces: ReadonlyArray<WorkspaceResource>,
  placedWorkspaces: ReadonlyMap<string, ReadonlyArray<WorkspaceHostStatus>>,
  world: World,
): Promise<void> {
  const plural = PLURALS.automations;
  interface Plan {
    readonly cr: AutomationResource;
    readonly definition: AutomationDefinition | null;
    readonly chosen: ReadonlyArray<string>;
    readonly errors: string[];
    message: string | null;
  }
  const plans = new Map<string, Plan>();
  // pod -> automation name -> its definition there.
  const desired = new Map<string, Map<string, AutomationDefinition>>();

  for (const cr of automations) {
    const name = cr.metadata.name;
    if (cr.metadata.deletionTimestamp) {
      plans.set(name, { cr, definition: null, chosen: [], errors: [], message: null });
      continue;
    }
    const plan: Plan = { cr, definition: null, chosen: [], errors: [], message: null };
    plans.set(name, plan);
    try {
      await addFinalizer(deps, cr, plural);
    } catch (error) {
      plan.errors.push(errorMessage(error));
      continue;
    }
    const workspace = workspaces.find((w) => w.metadata.name === cr.spec.workspace && !w.metadata.deletionTimestamp);
    if (!workspace) {
      plan.message = `AgentWorkspace ${cr.spec.workspace} not found`;
      continue;
    }
    let definition: AutomationDefinition;
    try {
      definition = automationDefinition(cr, workspace);
    } catch (error) {
      plans.set(name, { ...plan, errors: [errorMessage(error)] });
      continue;
    }
    const placed = placedWorkspaces.get(workspace.metadata.name) ?? [];
    const candidates = placed.map((p) => p.pod);
    const eligible = placed
      .filter((p) => p.phase === 'Ready' && world.host(p.pod)?.ready && world.agentHost(p.pod)?.automations)
      .map((p) => p.pod);
    const holding = (cr.status?.hosts ?? []).map((h) => h.pod);
    const chosen = choosePlacement(cr.spec.placement, candidates, eligible, holding);
    let message: string | null = null;
    if (chosen.length === 0) {
      const noCatalogue = placed.filter((p) => p.phase === 'Ready' && world.agentHost(p.pod) && !world.agentHost(p.pod)!.automations);
      message =
        candidates.length === 0
          ? `workspace ${workspace.metadata.name} is on no host`
          : noCatalogue.length > 0 && noCatalogue.length === candidates.length
            ? 'no host holding the workspace supports automations'
            : `waiting for workspace ${workspace.metadata.name} on a host`;
    }
    plans.set(name, { cr, definition, chosen, errors: [], message });
    for (const pod of chosen) {
      if (!desired.has(pod)) desired.set(pod, new Map());
      desired.get(pod)!.set(name, definition);
    }
  }

  // name -> pod -> the entry on that host after this pass.
  const present = new Map<string, Map<string, AutomationEntry | null>>();
  const record = (name: string, pod: string, entry: AutomationEntry | null) => {
    if (!present.has(name)) present.set(name, new Map());
    present.get(name)!.set(pod, entry);
  };
  const fail = (name: string, message: string) => plans.get(name)?.errors.push(message);
  const seen = new Set<string>();

  for (const pod of world.connected()) {
    const agentHost = world.agentHost(pod)!;
    const wanted = desired.get(pod) ?? new Map<string, AutomationDefinition>();
    if (!agentHost.automations) {
      for (const name of wanted.keys()) fail(name, `${pod}: the host has no automation catalogue`);
      continue;
    }
    let catalog: ReadonlyArray<AutomationEntry>;
    try {
      catalog = await agentHost.automationCatalog();
    } catch (error) {
      for (const name of wanted.keys()) fail(name, `${pod}: ${errorMessage(error)}`);
      continue;
    }
    seen.add(pod);
    const ours = new Map(catalog.flatMap((e) => (ownerOf(e) === null ? [] : [[ownerOf(e)!, e] as const])));

    for (const [name, definition] of wanted) {
      const resource = automationResource(name);
      const entry = ours.get(name) ?? catalog.find((e) => e.resource === resource);
      try {
        if (!entry) {
          await agentHost.createAutomation(resource, definition);
        } else if (entry.definition._meta?.[HASH_META] !== definition._meta?.[HASH_META]) {
          if (!entry.operations.includes('update' as never)) throw new Error('the host does not allow updating it');
          const { title, message, session, enabled, triggers } = definition;
          await agentHost.updateAutomation(entry.resource, { title, message, session, enabled, triggers, _meta: { ...entry.definition._meta, ...definition._meta } });
        }
        record(name, pod, entry ?? null);
      } catch (error) {
        fail(name, `${pod}: ${errorMessage(error)}`);
        if (entry) record(name, pod, entry);
      }
    }

    for (const [name, entry] of ours) {
      if (wanted.has(name)) continue;
      try {
        if (!entry.operations.includes('remove' as never)) throw new Error('the host does not allow removing it');
        await agentHost.removeAutomation(entry.resource);
      } catch (error) {
        record(name, pod, entry);
        fail(name, `${pod}: removal failed: ${errorMessage(error)}`);
      }
    }
  }

  // The entries as the hosts hold them now, for nextRunAt and the last run.
  for (const pod of seen) {
    let catalog: ReadonlyArray<AutomationEntry> = [];
    try {
      catalog = await world.agentHost(pod)!.automationCatalog();
    } catch {
      continue;
    }
    for (const entry of catalog) {
      const name = ownerOf(entry);
      if (name !== null && present.get(name)?.has(pod)) present.get(name)!.set(pod, entry);
    }
  }

  for (const plan of plans.values()) {
    const { cr } = plan;
    const name = cr.metadata.name;
    const here = present.get(name) ?? new Map<string, AutomationEntry | null>();
    // Hosts that held it and can't be seen now: still holding, as far as
    // anyone knows. One whose pod is gone is forgotten.
    const unseen = (cr.status?.hosts ?? []).filter((h) => !seen.has(h.pod) && world.host(h.pod) !== undefined);
    const hosts: AutomationHostStatus[] = [
      ...[...here.entries()].map(([pod, entry]) => ({
        pod,
        resource: entry?.resource ?? automationResource(name),
        nextRunAt: entry?.nextRunAt ?? null,
        lastRun: lastRunOf(entry ?? undefined),
      })),
      ...unseen,
    ].sort((a, b) => byName(a.pod, b.pod));

    try {
      if (cr.metadata.deletionTimestamp) {
        if (!cr.metadata.finalizers?.includes(FINALIZER)) continue;
        if (hosts.length === 0) {
          await removeFinalizer(deps, cr, plural);
        } else {
          await writeStatus(deps, plural, cr, {
            phase: 'Deleting',
            message: plan.errors.length > 0 ? plan.errors.join('; ') : `waiting to remove it from ${hosts.map((h) => h.pod).join(', ')}`,
            hosts,
          });
        }
        continue;
      }
      const phase = plan.errors.length > 0 ? 'Error' : plan.chosen.length === 0 ? 'Waiting' : plan.chosen.every((p) => here.has(p)) ? 'Ready' : 'Progressing';
      await writeStatus(deps, plural, cr, {
        phase,
        message: plan.errors.length > 0 ? plan.errors.join('; ') : plan.message,
        hosts,
      });
    } catch (error) {
      // Logged by the caller's next pass through status; keep going.
      plan.errors.push(errorMessage(error));
    }
  }
}

// ─── AgentHostSet ────────────────────────────────────────────────────────────

export interface Placed {
  readonly workspace: string;
  readonly phase: WorkspacePhase;
  readonly since: string | null;
}

// Whether a workspace placed on a host holds its content gate: while it is
// on its way (Waiting, or Cloning for up to CLONE_GATE_MS). An Error does
// not: it is in status for a person, and holding the gate on it would stall
// every later rollout.
export function holdsGate(p: Placed, now: Date): boolean {
  if (p.phase === 'Waiting') return true;
  if (p.phase !== 'Cloning') return false;
  return p.since === null || now.getTime() - Date.parse(p.since) < CLONE_GATE_MS;
}

export const addressOf = (spec: HostSetSpec, pod: string) => (spec.address ? spec.address.replaceAll('{pod}', pod) : null);

// Sets each host's content-ready gate and the set's status.
export async function reconcileHostSet(
  deps: Deps,
  cr: HostSetResource,
  set: PlacedSet,
  world: World,
  workspaces: ReadonlyMap<string, ReadonlyArray<Placed>>,
): Promise<void> {
  const plural = PLURALS.hostSets;
  if (set.hosts === null) {
    await writeStatus(deps, plural, cr, { phase: 'Error', message: `StatefulSet ${cr.spec.statefulSet} not found`, hosts: [] });
    return;
  }
  const now = deps.now();
  const hosts: HostStatus[] = [];
  for (const host of set.hosts) {
    const placed = workspaces.get(host.name) ?? [];
    const pending = placed.filter((p) => holdsGate(p, now)).map((p) => p.workspace);
    const contentReady = pending.length === 0;
    if (host.contentReady !== contentReady) {
      await deps.kube.setContentReady(
        host.name,
        contentReady,
        contentReady ? `${placed.length} workspace(s) in place` : `waiting for ${pending.join(', ')}`,
      );
    }
    const agentHost = world.agentHost(host.name);
    const failed = placed.filter((p) => p.phase === 'Error').map((p) => p.workspace);
    let phase: HostPhase;
    let message: string | null = null;
    if (!host.ready) {
      phase = 'Pending';
      message = 'pod not ready';
    } else if (!agentHost) {
      phase = 'Error';
      message = set.error ?? world.connectionError(host.name) ?? 'not connected';
    } else if (failed.length > 0) {
      phase = 'Degraded';
      message = `workspace(s) failed: ${failed.join(', ')}`;
    } else if (!contentReady) {
      phase = 'Pending';
      message = `waiting for ${pending.join(', ')}`;
    } else {
      phase = 'Ready';
    }
    hosts.push({
      pod: host.name,
      phase,
      address: addressOf(cr.spec, host.name),
      protocolVersion: agentHost?.protocolVersion ?? null,
      serverInfo: agentHost?.serverInfo ?? null,
      agents: agentHost ? [...agentHost.agents()].sort() : [],
      contentReady,
      workspaces: placed.map((p) => ({ name: p.workspace, phase: p.phase })),
      message,
    });
  }
  const phases = hosts.map((h) => h.phase);
  await writeStatus(deps, plural, cr, {
    phase: phases.includes('Error') ? 'Error' : phases.includes('Degraded') ? 'Degraded' : phases.every((p) => p === 'Ready') ? 'Ready' : 'Progressing',
    message: set.error ?? null,
    hosts,
  });
}

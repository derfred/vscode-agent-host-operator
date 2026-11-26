// The few Kubernetes API calls the operator makes, over fetch with the pod's
// ServiceAccount. The API server's CA reaches fetch through
// NODE_EXTRA_CA_CERTS (set in the Deployment), so no client library is needed.
// From t3code-operator's kube.ts: a new group, Secrets for the connection
// tokens, and exec with a timeout per call (a clone runs long).

import { readFileSync } from 'node:fs';

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
export const GROUP = 'agenthost.derfred.com';
export const VERSION = 'v1alpha1';
// The pod readiness gate the agent host pods declare (see README.md).
export const CONTENT_READY = `${GROUP}/content-ready`;

export interface Metadata {
  readonly name: string;
  readonly uid?: string;
  readonly generation?: number;
  readonly resourceVersion?: string;
  readonly deletionTimestamp?: string;
  readonly finalizers?: ReadonlyArray<string>;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface Resource<Spec, Status> {
  readonly metadata: Metadata;
  readonly spec: Spec;
  readonly status?: Status;
}

// One agent host: a pod of a host set's StatefulSet.
export interface Host {
  readonly name: string;
  readonly uid: string;
  // The operator talks to the host on the pod's IP: no Service per pod needed.
  readonly ip: string | null;
  // ContainersReady, not Ready: Ready also waits on the content gate, which
  // the operator itself sets, after it has talked to the host.
  readonly ready: boolean;
  readonly contentReady: boolean | undefined;
  // The pod's containers, in order: the first is exec's default.
  readonly containers: ReadonlyArray<string>;
}

export interface ExecOptions {
  // How long the command may run. Default EXEC_TIMEOUT_MS.
  readonly timeoutMs?: number;
}

export interface Kube {
  list<R>(plural: string): Promise<ReadonlyArray<R>>;
  // A raw authenticated GET, for watches (watch.ts).
  get(path: string, signal: AbortSignal): Promise<Response>;
  // Merge patch. Include metadata.resourceVersion to make it conditional.
  patch(plural: string, name: string, body: unknown): Promise<void>;
  patchStatus(plural: string, name: string, status: unknown): Promise<void>;
  // null when the StatefulSet does not exist.
  statefulSetHosts(name: string): Promise<ReadonlyArray<Host> | null>;
  // One key of a Secret, decoded; null when the Secret or the key is missing.
  secretValue(name: string, key: string): Promise<string | null>;
  setContentReady(pod: string, ready: boolean, message: string): Promise<void>;
  // Runs a command in a pod's container (pods/exec); its stdout, or an error
  // when it can't run or exits non-zero. For clones (clones.ts).
  exec(pod: string, container: string, command: ReadonlyArray<string>, options?: ExecOptions): Promise<string>;
}

export class KubeError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'KubeError';
    this.status = status;
  }
}

const condition = (pod: any, type: string) =>
  (pod.status?.conditions ?? []).find((c: any) => c.type === type)?.status;

export function toHost(pod: any): Host {
  const gate = condition(pod, CONTENT_READY);
  const ip = pod.status?.podIP ?? null;
  return {
    name: pod.metadata.name,
    uid: pod.metadata.uid,
    ip,
    ready: !pod.metadata.deletionTimestamp && ip !== null && condition(pod, 'ContainersReady') === 'True',
    contentReady: gate === undefined ? undefined : gate === 'True',
    containers: (pod.spec?.containers ?? []).map((c: any) => String(c.name)),
  };
}

// The exec WebSocket's channels: the first byte of each binary message.
const STDOUT = 1;
const STDERR = 2;
// A metav1.Status as the last message: Success, or why not.
const STATUS = 3;
export const EXEC_TIMEOUT_MS = 60_000;

// What an exec came to, from the bytes of each channel.
export function execOutcome(channels: ReadonlyMap<number, ReadonlyArray<Uint8Array>>): { ok: true; stdout: string } | { ok: false; error: string } {
  const text = (channel: number) => Buffer.concat(channels.get(channel) ?? []).toString('utf8');
  const statusText = text(STATUS);
  if (!statusText) return { ok: false, error: 'the connection closed without an exit status' };
  let status;
  try {
    status = JSON.parse(statusText);
  } catch {
    return { ok: false, error: `unreadable exit status: ${statusText.slice(0, 200)}` };
  }
  if (status.status === 'Success') return { ok: true, stdout: text(STDOUT) };
  const stderr = text(STDERR).trim();
  return { ok: false, error: [status.message ?? status.reason ?? 'failed', stderr.slice(-500)].filter(Boolean).join(': ') };
}

export function makeKube(namespace: string): Kube {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT ?? '443';
  if (!host) throw new Error('KUBERNETES_SERVICE_HOST is not set; the operator runs in-cluster only');
  const base = `https://${host.includes(':') ? `[${host}]` : host}:${port}`;
  const custom = `/apis/${GROUP}/${VERSION}/namespaces/${namespace}`;

  // Re-read on every call: the projected token rotates.
  const authorization = () => `Bearer ${readFileSync(`${SA_DIR}/token`, 'utf8').trim()}`;

  const request = async (method: string, path: string, body?: unknown, contentType = 'application/merge-patch+json') => {
    const response = await fetch(base + path, {
      method,
      headers: {
        authorization: authorization(),
        ...(body === undefined ? {} : { 'content-type': contentType }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new KubeError(`${method} ${path}: HTTP ${response.status} ${text.slice(0, 300)}`, response.status);
    }
    return text.length === 0 ? undefined : JSON.parse(text);
  };

  const getOrNull = async (path: string) => {
    try {
      return await request('GET', path);
    } catch (error) {
      if (error instanceof KubeError && error.status === 404) return null;
      throw error;
    }
  };

  return {
    list: async (plural) => (await request('GET', `${custom}/${plural}`)).items,
    get: (path, signal) => fetch(base + path, { headers: { authorization: authorization() }, signal }),
    patch: async (plural, name, body) => {
      await request('PATCH', `${custom}/${plural}/${name}`, body);
    },
    patchStatus: async (plural, name, status) => {
      await request('PATCH', `${custom}/${plural}/${name}/status`, { status });
    },
    statefulSetHosts: async (name) => {
      const sts = await getOrNull(`/apis/apps/v1/namespaces/${namespace}/statefulsets/${encodeURIComponent(name)}`);
      if (sts === null) return null;
      // The StatefulSet's own selector, so pods are found the way it finds them.
      const selector = Object.entries(sts.spec.selector.matchLabels ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
      const pods = await request('GET', `/api/v1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent(selector)}`);
      return pods.items.map(toHost).sort((a: Host, b: Host) => a.name.localeCompare(b.name, 'en', { numeric: true }));
    },
    secretValue: async (name, key) => {
      const secret = await getOrNull(`/api/v1/namespaces/${namespace}/secrets/${encodeURIComponent(name)}`);
      const value = secret?.data?.[key];
      return typeof value === 'string' ? Buffer.from(value, 'base64').toString('utf8').trim() : null;
    },
    exec: async (pod, container, command, options = {}) => {
      const timeoutMs = options.timeoutMs ?? EXEC_TIMEOUT_MS;
      const query = new URLSearchParams({ container, stdout: 'true', stderr: 'true' });
      for (const arg of command) query.append('command', arg);
      const path = `/api/v1/namespaces/${namespace}/pods/${encodeURIComponent(pod)}/exec?${query}`;
      const failed = (detail: string) => new KubeError(`exec in ${pod}/${container} (${command.slice(0, 4).join(' ')}): ${detail}`, 0);
      // v5 and v4 both end with a Status on channel 3; v5 only adds a way to
      // close stdin, which this never opens. Node's WebSocket (undici) takes
      // headers, and the API server's CA from NODE_EXTRA_CA_CERTS, as fetch does.
      const ws = new WebSocket(base.replace(/^http/, 'ws') + path, {
        protocols: ['v5.channel.k8s.io', 'v4.channel.k8s.io'],
        headers: { authorization: authorization() },
      } as any);
      ws.binaryType = 'arraybuffer';
      const channels = new Map<number, Uint8Array[]>();
      let errored = false;
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          errored = true;
          ws.close();
          reject(failed(`no exit within ${timeoutMs / 1000}s`));
        }, timeoutMs);
        ws.addEventListener('message', (event) => {
          const bytes = new Uint8Array(event.data as ArrayBuffer);
          if (bytes.length === 0) return;
          channels.set(bytes[0]!, [...(channels.get(bytes[0]!) ?? []), bytes.subarray(1)]);
        });
        ws.addEventListener('close', () => {
          // After an error or a timeout, which reports it.
          if (errored) return;
          clearTimeout(timer);
          const outcome = execOutcome(channels);
          if (outcome.ok) resolve(outcome.stdout);
          else reject(failed(outcome.error));
        });
        ws.addEventListener('error', () => {
          if (errored) return;
          // A refused upgrade (no RBAC, no such pod) reaches the WebSocket
          // with no reason. The same request as a POST gets it in words.
          errored = true;
          clearTimeout(timer);
          request('POST', path).then(
            () => reject(failed('the WebSocket failed')),
            (error) => reject(failed(error instanceof KubeError && error.status === 400 ? 'the WebSocket failed' : String(error.message ?? error))),
          );
        });
      });
    },
    setContentReady: async (pod, ready, message) => {
      // Strategic merge: conditions merge by type. A JSON merge patch would
      // replace the whole list, kubelet's conditions included.
      await request(
        'PATCH',
        `/api/v1/namespaces/${namespace}/pods/${pod}/status`,
        {
          status: {
            conditions: [
              {
                type: CONTENT_READY,
                status: ready ? 'True' : 'False',
                reason: ready ? 'ContentReady' : 'ContentPending',
                message,
                lastTransitionTime: new Date().toISOString(),
              },
            ],
          },
        },
        'application/strategic-merge-patch+json',
      );
    },
  };
}

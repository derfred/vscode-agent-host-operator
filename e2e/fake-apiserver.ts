// A fake Kubernetes API server for the end-to-end test: just enough of the
// real one's REST conventions for the operator to run against it unchanged.
// HTTPS with a CA the test makes; any bearer token is accepted.
//
// Collections and objects at the usual paths:
//   /api/v1/namespaces/{ns}/{plural}[/{name}[/status]]
//   /apis/{group}/{version}/namespaces/{ns}/{plural}[/{name}[/status]]
//
// - GET a collection: a list, filtered by an equality labelSelector; with
//   ?watch=1, a stream of JSON-line events from resourceVersion on, ended
//   after timeoutSeconds.
// - POST a collection: create. PATCH an object or its /status: JSON merge
//   patch (RFC 7386), or strategic merge for pods/status, where conditions
//   merge by type. metadata.resourceVersion in a patch is a precondition
//   (409 on mismatch). Patching an object leaves its status alone (status
//   subresource), patching /status leaves everything else alone.
// - DELETE: an object with finalizers gets a deletionTimestamp and stays
//   until a patch empties them, as on a real cluster.
// - generation counts spec changes; resourceVersion is one counter for all.
// - pods/{name}/exec: a WebSocket upgrade, answered in v4/v5.channel.k8s.io
//   (stdout on channel 1, stderr on 2, a metav1.Status on 3, then close),
//   by running the command with the `exec` the test gives.

import { createHash, randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';

type Obj = Record<string, any>;
interface Event {
  readonly rv: number;
  readonly type: 'ADDED' | 'MODIFIED' | 'DELETED';
  readonly collection: string;
  readonly object: Obj;
}

const PATH =
  /^\/(?:api\/(?<coreVersion>v1)|apis\/(?<group>[^/]+)\/(?<version>[^/]+))\/namespaces\/(?<ns>[^/]+)\/(?<plural>[^/]+)(?:\/(?<name>[^/]+))?(?:\/(?<sub>status))?$/;

const EXEC_PATH = /^\/api\/v1\/namespaces\/(?<ns>[^/]+)\/pods\/(?<pod>[^/]+)\/exec$/;

// How the test runs a command in a pod.
export type ExecHandler = (
  pod: string,
  container: string,
  command: string[],
) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;

// One unmasked server frame: binary (0x2) or close (0x8).
function wsFrame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  if (n >= 126 && n < 65536) {
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(n, 2);
  } else if (n >= 65536) {
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, payload]);
}

const clone = <T>(v: T): T => structuredClone(v);

export function mergePatch(target: any, patch: any): any {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return clone(patch);
  const out: Obj = target !== null && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

// Strategic merge, as far as pod status needs it: conditions merge by type.
function strategicPodStatus(target: Obj, patch: Obj): Obj {
  const conditions = patch.status?.conditions;
  if (!conditions) return mergePatch(target, patch);
  const { conditions: _merged, ...statusRest } = patch.status;
  const rest = mergePatch(target, { ...patch, status: statusRest });
  const merged = [...(target.status?.conditions ?? [])];
  for (const c of conditions) {
    const i = merged.findIndex((m: Obj) => m.type === c.type);
    if (i >= 0) merged[i] = { ...merged[i], ...c };
    else merged.push(c);
  }
  return { ...rest, status: { ...rest.status, conditions: merged } };
}

const matchesSelector = (labels: Obj = {}, selector: string | null) =>
  !selector ||
  selector
    .split(',')
    .filter(Boolean)
    .every((term) => {
      const [k, v] = term.split('=');
      return labels[k!] === v;
    });

export class FakeApiServer {
  readonly #objects = new Map<string, Map<string, Obj>>(); // collection -> name -> object
  readonly #events: Event[] = [];
  readonly #watchers = new Set<(e: Event) => void>();
  #rv = 1;
  #server: Server | undefined;
  readonly requests: Array<{ method: string; path: string }> = [];
  // Set by the test before the operator first execs.
  exec: ExecHandler | undefined;

  // collection: '/api/v1/namespaces/agents/pods' and the like.
  #collection(collection: string) {
    let c = this.#objects.get(collection);
    if (!c) this.#objects.set(collection, (c = new Map()));
    return c;
  }

  #emit(type: Event['type'], collection: string, object: Obj) {
    const event = { rv: Number(object.metadata.resourceVersion), type, collection, object: clone(object) };
    this.#events.push(event);
    for (const w of this.#watchers) w(event);
  }

  #store(collection: string, next: Obj, previous: Obj | undefined) {
    next.metadata.resourceVersion = String(++this.#rv);
    if (previous && JSON.stringify(previous.spec) !== JSON.stringify(next.spec)) {
      next.metadata.generation = (previous.metadata.generation ?? 1) + 1;
    }
    // The last finalizer gone from an object being deleted: it goes.
    if (next.metadata.deletionTimestamp && (next.metadata.finalizers ?? []).length === 0) {
      this.#collection(collection).delete(next.metadata.name);
      this.#emit('DELETED', collection, next);
      return next;
    }
    this.#collection(collection).set(next.metadata.name, next);
    this.#emit(previous ? 'MODIFIED' : 'ADDED', collection, next);
    return next;
  }

  // ─── direct access, for the test ──────────────────────────────────────────

  create(collection: string, object: Obj): Obj {
    const name = object.metadata.name;
    if (this.#collection(collection).has(name)) throw new Error(`${collection}/${name} exists`);
    const next = clone(object);
    next.metadata = { ...next.metadata, uid: randomUUID(), generation: 1, creationTimestamp: new Date().toISOString() };
    return clone(this.#store(collection, next, undefined));
  }

  list(collection: string): Obj[] {
    return [...this.#collection(collection).values()].map(clone);
  }

  get(collection: string, name: string): Obj | undefined {
    const o = this.#collection(collection).get(name);
    return o && clone(o);
  }

  // A merge patch, as an outside client: spec, metadata and status alike.
  patch(collection: string, name: string, patch: Obj): Obj {
    const current = this.#collection(collection).get(name);
    if (!current) throw new Error(`${collection}/${name} not found`);
    return clone(this.#store(collection, mergePatch(current, patch), current));
  }

  delete(collection: string, name: string): void {
    const current = this.#collection(collection).get(name);
    if (!current) return;
    if ((current.metadata.finalizers ?? []).length > 0) {
      if (!current.metadata.deletionTimestamp) {
        this.#store(collection, mergePatch(current, { metadata: { deletionTimestamp: new Date().toISOString() } }), current);
      }
      return;
    }
    this.#collection(collection).delete(name);
    current.metadata.resourceVersion = String(++this.#rv);
    this.#emit('DELETED', collection, current);
  }

  // ─── HTTP ─────────────────────────────────────────────────────────────────

  listen(options: { key: string; cert: string; host?: string; port?: number }): Promise<number> {
    this.#server = createServer({ key: options.key, cert: options.cert }, (req, res) => {
      this.#handle(req, res).catch((error) => this.#send(res, 500, { message: String(error) }));
    });
    this.#server.on('upgrade', (req, socket) => {
      this.#upgrade(req, socket).catch(() => socket.destroy());
    });
    return new Promise((resolve) =>
      this.#server!.listen(options.port ?? 0, options.host ?? '0.0.0.0', () => resolve((this.#server!.address() as any).port)),
    );
  }

  close(): Promise<void> {
    this.#watchers.clear();
    this.#server?.closeAllConnections();
    return new Promise((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }

  #send(res: ServerResponse, status: number, body: unknown) {
    if (res.headersSent) return res.end();
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(status >= 400 ? { kind: 'Status', status: 'Failure', code: status, ...(body as Obj) } : body));
  }

  async #body(req: IncomingMessage): Promise<Obj> {
    let text = '';
    for await (const chunk of req) text += chunk;
    return text ? JSON.parse(text) : {};
  }

  async #handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, 'https://fake');
    this.requests.push({ method: req.method!, path: url.pathname + url.search });
    if (!/^Bearer \S+/.test(req.headers.authorization ?? '')) {
      return this.#send(res, 401, { message: 'Unauthorized' });
    }
    const m = PATH.exec(url.pathname);
    if (!m) return this.#send(res, 404, { message: `no route ${url.pathname}` });
    const { coreVersion, group, version, ns, plural, name, sub } = m.groups!;
    const collection = coreVersion ? `/api/v1/namespaces/${ns}/${plural}` : `/apis/${group}/${version}/namespaces/${ns}/${plural}`;
    const items = this.#collection(collection);
    const selector = url.searchParams.get('labelSelector');

    if (req.method === 'GET' && !name) {
      if (url.searchParams.get('watch') === '1') return this.#watch(req, res, url, collection, selector);
      const list = [...items.values()].filter((o) => matchesSelector(o.metadata.labels, selector));
      return this.#send(res, 200, { kind: 'List', metadata: { resourceVersion: String(this.#rv) }, items: list });
    }
    if (req.method === 'POST' && !name) {
      const body = await this.#body(req);
      if (items.has(body.metadata?.name)) return this.#send(res, 409, { reason: 'AlreadyExists', message: 'exists' });
      return this.#send(res, 201, this.create(collection, body));
    }
    if (!name) return this.#send(res, 405, { message: 'method not allowed' });

    const current = items.get(name);
    if (!current) return this.#send(res, 404, { reason: 'NotFound', message: `${plural} "${name}" not found` });
    if (req.method === 'GET') return this.#send(res, 200, current);
    if (req.method === 'DELETE') {
      this.delete(collection, name);
      return this.#send(res, 200, { kind: 'Status', status: 'Success' });
    }
    if (req.method === 'PATCH') {
      const patch = await this.#body(req);
      const expected = patch.metadata?.resourceVersion;
      if (expected !== undefined && expected !== current.metadata.resourceVersion) {
        return this.#send(res, 409, { reason: 'Conflict', message: 'the object has been modified' });
      }
      const type = req.headers['content-type'] ?? '';
      let next: Obj;
      if (sub === 'status') {
        // Only status changes through /status.
        const patched = type.startsWith('application/strategic-merge-patch') ? strategicPodStatus(current, patch) : mergePatch(current, patch);
        next = { ...current, status: patched.status };
      } else {
        const { status: _ignored, ...rest } = patch;
        next = { ...mergePatch(current, rest), status: current.status };
      }
      next.metadata = { ...next.metadata, resourceVersion: current.metadata.resourceVersion };
      return this.#send(res, 200, this.#store(collection, next, current));
    }
    return this.#send(res, 405, { message: 'method not allowed' });
  }

  async #upgrade(req: IncomingMessage, socket: Duplex) {
    const url = new URL(req.url!, 'https://fake');
    this.requests.push({ method: 'EXEC', path: url.pathname + url.search });
    const refuse = (status: string) => socket.end(`HTTP/1.1 ${status}\r\nconnection: close\r\n\r\n`);
    if (!/^Bearer \S+/.test(req.headers.authorization ?? '')) return refuse('401 Unauthorized');
    const m = EXEC_PATH.exec(url.pathname);
    const key = req.headers['sec-websocket-key'];
    if (!m || typeof key !== 'string') return refuse('404 Not Found');
    const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim());
    const protocol = offered.find((p) => p === 'v5.channel.k8s.io' || p === 'v4.channel.k8s.io');
    if (!protocol) return refuse('400 Bad Request');
    const pod = this.get(`/api/v1/namespaces/${m.groups!.ns}/pods`, m.groups!.pod!);
    if (!pod) return refuse('404 Not Found');
    if (!this.exec) return refuse('501 Not Implemented');

    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n` +
        `sec-websocket-accept: ${accept}\r\nsec-websocket-protocol: ${protocol}\r\n\r\n`,
    );
    // Nothing comes from the client but a close, which needs no answer here.
    socket.on('data', () => undefined);
    socket.on('error', () => undefined);
    const channel = (n: number, text: string) => socket.write(wsFrame(0x2, Buffer.concat([Buffer.from([n]), Buffer.from(text)])));

    const container = url.searchParams.get('container') ?? pod.spec?.containers?.[0]?.name ?? '';
    let status: Obj;
    try {
      const out = await this.exec(m.groups!.pod!, container, url.searchParams.getAll('command'));
      if (out.stdout) channel(1, out.stdout);
      if (out.stderr) channel(2, out.stderr);
      status =
        out.exitCode === 0
          ? { metadata: {}, status: 'Success' }
          : {
              metadata: {},
              status: 'Failure',
              reason: 'NonZeroExitCode',
              message: `command terminated with non-zero exit code: exit code ${out.exitCode}`,
              details: { causes: [{ reason: 'ExitCode', message: String(out.exitCode) }] },
            };
    } catch (error) {
      status = { metadata: {}, status: 'Failure', reason: 'InternalError', message: String(error) };
    }
    channel(3, JSON.stringify(status));
    const code = Buffer.alloc(2);
    code.writeUInt16BE(1000);
    socket.end(wsFrame(0x8, code));
  }

  #watch(req: IncomingMessage, res: ServerResponse, url: URL, collection: string, selector: string | null) {
    const from = Number(url.searchParams.get('resourceVersion') ?? this.#rv);
    const timeout = Number(url.searchParams.get('timeoutSeconds') ?? 300) * 1000;
    res.writeHead(200, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' });
    const send = (e: Event) => {
      if (e.collection !== collection || e.rv <= from || !matchesSelector(e.object.metadata.labels, selector)) return;
      res.write(JSON.stringify({ type: e.type, object: e.object }) + '\n');
    };
    for (const e of this.#events) send(e);
    this.#watchers.add(send);
    const end = () => {
      clearTimeout(timer);
      this.#watchers.delete(send);
      res.end();
    };
    const timer = setTimeout(end, timeout);
    req.on('close', end);
  }
}

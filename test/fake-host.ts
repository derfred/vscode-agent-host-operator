// A fake agent host: the server half of an InMemoryTransport pair, speaking
// enough AHP for the operator: initialize, ping, resourceList,
// resourceDelete, subscribe to ahp-automations://, and the automation
// actions. By default it answers those as VS Code 1.148's host does (seen
// with scripts/probe.ts): a refusal is echoed with the client's origin and a
// rejectionReason; an accepted action is not echoed, the host publishes its
// result instead (automation/set, automation/removed) with no origin.
// `echo: true` answers as the AHP spec has it: every action echoed.

import type { AutomationDefinition, AutomationEntry } from '@microsoft/agent-host-protocol';
import { InMemoryTransport, type AhpTransport } from '@microsoft/agent-host-protocol/client';

export interface FakeHostOptions {
  readonly protocolVersions?: ReadonlyArray<string>;
  readonly agents?: ReadonlyArray<string>;
  readonly automations?: boolean;
  // path -> entry names; a path not here doesn't exist.
  readonly files?: Record<string, string[]>;
  // Refuses dispatched actions with this reason.
  readonly reject?: string;
  // Echoes accepted actions with their origin too (the spec's write-ahead).
  readonly echo?: boolean;
  // The root config value automationsEnabled (off on a new host).
  readonly automationsEnabled?: boolean;
}

export class FakeHost {
  readonly client: AhpTransport;
  readonly #server: AhpTransport;
  readonly files: Map<string, string[]>;
  readonly catalog = new Map<string, AutomationEntry>();
  readonly received: Array<{ method: string; params: any }> = [];
  options: FakeHostOptions;
  automationsEnabled: boolean;
  #serverSeq = 0;

  constructor(options: FakeHostOptions = {}) {
    this.options = options;
    this.files = new Map(Object.entries(options.files ?? {}));
    this.automationsEnabled = options.automationsEnabled ?? false;
    [this.client, this.#server] = InMemoryTransport.pair();
    void this.#serve();
  }

  #send(message: unknown) {
    void this.#server.send(JSON.stringify(message));
  }

  #action(channel: string, action: unknown, origin?: unknown, rejectionReason?: string) {
    this.#send({
      jsonrpc: '2.0',
      method: 'action',
      params: { channel, action, serverSeq: ++this.#serverSeq, origin, ...(rejectionReason ? { rejectionReason } : {}) },
    });
  }

  entry(resource: string, definition: AutomationDefinition): AutomationEntry {
    return {
      resource,
      definition,
      runs: [],
      operations: ['update', 'remove'] as never,
      createdAt: '2026-11-26T00:00:00.000Z',
      modifiedAt: '2026-11-26T00:00:00.000Z',
      nextRunAt: '2026-11-27T03:00:00.000Z',
    };
  }

  async #serve() {
    for (;;) {
      const frame = await this.#server.recv();
      if (frame === null) return;
      const message = JSON.parse(frame.kind === 'text' ? frame.text : JSON.stringify((frame as any).message));
      this.received.push({ method: message.method, params: message.params });
      if (message.id === undefined) {
        this.#notification(message.method, message.params);
        continue;
      }
      try {
        this.#send({ jsonrpc: '2.0', id: message.id, result: this.#request(message.method, message.params) });
      } catch (error: any) {
        this.#send({ jsonrpc: '2.0', id: message.id, error: { code: error.code ?? -32000, message: error.message, data: error.data } });
      }
    }
  }

  #request(method: string, params: any): unknown {
    switch (method) {
      case 'initialize': {
        const supported = this.options.protocolVersions ?? ['1.1.0', '1.0.0'];
        const version = (params.protocolVersions as string[]).find((v) => supported.includes(v));
        if (!version) throw Object.assign(new Error('unsupported protocol version'), { code: -32005, data: { supportedVersions: supported } });
        return {
          protocolVersion: version,
          serverSeq: this.#serverSeq,
          serverInfo: { name: 'fake-host', version: '0.0.1' },
          snapshots: [
            {
              resource: 'ahp-root://',
              fromSeq: this.#serverSeq,
              state: {
                agents: (this.options.agents ?? ['claude', 'codex', 'copilotcli']).map((provider) => ({ provider, displayName: provider, description: '', models: [] })),
                config: { schema: { type: 'object', properties: {} }, values: { automationsEnabled: this.automationsEnabled } },
              },
            },
          ],
          ...(this.options.automations === false ? {} : { automations: { create: {}, schedules: {} } }),
        };
      }
      case 'ping':
        return {};
      case 'subscribe':
        if (params.resource !== 'ahp-automations://' && params.channel !== 'ahp-automations://' && params.uri !== 'ahp-automations://') {
          throw new Error(`unknown channel ${JSON.stringify(params)}`);
        }
        return { snapshot: { resource: 'ahp-automations://', fromSeq: this.#serverSeq, state: { entries: [...this.catalog.values()] } } };
      case 'resourceList': {
        const path = new URL(params.uri).pathname;
        const entries = this.files.get(path);
        if (!entries) throw Object.assign(new Error(`ENOENT: ${path}`), { code: -32002 });
        return { entries: entries.map((name) => ({ name, type: 'file' })) };
      }
      case 'resourceDelete': {
        const path = new URL(params.uri).pathname;
        if (!this.files.has(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: -32002 });
        this.files.delete(path);
        return {};
      }
      default:
        throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
    }
  }

  #notification(method: string, params: any) {
    if (method !== 'dispatchAction') return;
    const { channel, clientSeq, action } = params;
    const origin = { clientId: this.#clientId(), clientSeq };
    if (this.options.reject) {
      this.#action(channel, action, origin, this.options.reject);
      return;
    }
    // Root config changes are echoed with their origin, as 1.148 does.
    if (action.type === 'root/configChanged') {
      if (action.config.automationsEnabled !== undefined) this.automationsEnabled = action.config.automationsEnabled;
      this.#action(channel, action, origin);
      return;
    }
    if (this.options.echo) this.#action(channel, action, origin);
    if (action.type === 'automation/createRequested') {
      const entry = this.entry(action.resource, action.definition);
      this.catalog.set(action.resource, entry);
      this.#action(channel, { type: 'automation/set', automation: entry });
    } else if (action.type === 'automation/updateRequested') {
      const current = this.catalog.get(action.resource)!;
      const entry = { ...current, definition: { ...current.definition, ...action.changes } };
      this.catalog.set(action.resource, entry);
      this.#action(channel, { type: 'automation/set', automation: entry });
    } else if (action.type === 'automation/removed') {
      if (this.catalog.delete(action.resource)) this.#action(channel, { type: 'automation/removed', resource: action.resource });
    }
  }

  #clientId(): string {
    return this.received.find((r) => r.method === 'initialize')?.params.clientId ?? '';
  }
}

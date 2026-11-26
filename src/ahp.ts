// One Agent Host Protocol connection to one agent host, over the official
// TypeScript client (@microsoft/agent-host-protocol). The operator is an AHP
// client like the Agents window: it connects to ws://<pod IP>:<port>/?tkn=…
// inside the cluster, so the token never leaves it.
//
// What it uses (docs/design.md, Talking to the host):
//
// - initialize: the version handshake; the root snapshot names the agents.
// - resourceList / resourceDelete: is a checkout there, remove a folder.
// - the ahp-automations:// channel: the host's durable automation catalogue,
//   changed with automation/createRequested, automation/updateRequested and
//   automation/removed. Those are write-ahead actions: the host echoes each
//   one back with our origin, carrying a rejectionReason when it refused it.

import {
  type ActionEnvelope,
  type AutomationDefinition,
  type AutomationDefinitionPatch,
  type AutomationEntry,
  type DirectoryEntry,
  type InitializeResult,
  type StateAction,
} from '@microsoft/agent-host-protocol';
import { AhpClient, AhpStateMirror, RpcError, type AhpTransport } from '@microsoft/agent-host-protocol/client';
import { WebSocketTransport } from '@microsoft/agent-host-protocol/ws';

// The protocol versions the operator was tested against, most preferred
// first. AHP is young and changes between releases: the end-to-end test runs
// against each new host image before these grow (docs/design.md).
export const PROTOCOL_VERSIONS: ReadonlyArray<string> = ['1.1.0', '1.0.0'];
export const ROOT = 'ahp-root://';
export const AUTOMATIONS = 'ahp-automations://';
// AHP's UnsupportedProtocolVersion error code.
const UNSUPPORTED_PROTOCOL_VERSION = -32005;
export const REQUEST_TIMEOUT_MS = 30_000;

export class AhpError extends Error {
  // Unsupported protocol version: the host is up but speaks nothing the
  // operator offers. Not retried until the pod changes.
  readonly unsupportedVersion: boolean;
  constructor(message: string, options: { readonly unsupportedVersion?: boolean; readonly cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'AhpError';
    this.unsupportedVersion = options.unsupportedVersion ?? false;
  }
}

export interface AgentHost {
  readonly protocolVersion: string;
  // "<name> <version>" of the host software, when it says.
  readonly serverInfo: string | null;
  // Whether the host has an automation catalogue clients may add to.
  readonly automations: boolean;
  // The agent providers the host offers (copilot, claude, codex, …), as of now.
  agents(): ReadonlyArray<string>;
  alive(): boolean;
  ping(): Promise<void>;
  // A folder's entries; null when the folder doesn't exist.
  list(path: string): Promise<ReadonlyArray<DirectoryEntry> | null>;
  // Removes a folder and everything in it. A missing folder is not an error.
  remove(path: string): Promise<void>;
  automationCatalog(): Promise<ReadonlyArray<AutomationEntry>>;
  createAutomation(resource: string, definition: AutomationDefinition): Promise<void>;
  updateAutomation(resource: string, changes: AutomationDefinitionPatch): Promise<void>;
  removeAutomation(resource: string): Promise<void>;
  close(): void;
}

export const fileUri = (path: string) => new URL(`file://${path.startsWith('/') ? '' : '/'}${path}`).href;

// The host's WebSocket address. It takes the connection token only as the
// tkn query parameter.
export function hostUrl(ip: string, port: number, token: string): string {
  const host = ip.includes(':') ? `[${ip}]` : ip;
  return `ws://${host}:${port}/?tkn=${encodeURIComponent(token)}`;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface OpenOptions {
  readonly clientId: string;
  readonly protocolVersions?: ReadonlyArray<string>;
  readonly requestTimeoutMs?: number;
}

// Opens a connection over a WebSocket.
export async function connectHost(url: string, options: OpenOptions): Promise<AgentHost> {
  let transport;
  try {
    transport = await WebSocketTransport.connect(url);
  } catch (error) {
    // The URL carries the token: say where, not what.
    throw new AhpError(`connecting to ${new URL(url).host}: ${errorMessage(error)}`, { cause: error });
  }
  return openHost(transport, options);
}

type Waiter = { readonly resolve: () => void; readonly reject: (error: Error) => void; readonly timer: ReturnType<typeof setTimeout> };

// Opens a connection over any transport (tests use InMemoryTransport).
export async function openHost(transport: AhpTransport, options: OpenOptions): Promise<AgentHost> {
  const timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const client = new AhpClient(transport, { requestTimeoutMs: timeoutMs });
  const mirror = new AhpStateMirror();
  // Our dispatches, by clientSeq, until the host echoes them.
  const waiters = new Map<number, Waiter>();
  const failWaiters = (error: Error) => {
    for (const [seq, waiter] of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
      waiters.delete(seq);
    }
  };

  // Attached before initialize, so no action is missed.
  const events = client.events();
  const pump = (async () => {
    for await (const { event } of events) {
      if (event.type !== 'action') continue;
      const envelope: ActionEnvelope = event.params;
      try {
        if (!envelope.rejectionReason) mirror.apply(envelope);
      } catch {
        // An action the mirror can't apply (from a newer protocol): the next
        // snapshot puts it right.
      }
      if (envelope.origin?.clientId !== options.clientId) continue;
      const waiter = waiters.get(envelope.origin.clientSeq);
      if (!waiter) continue;
      waiters.delete(envelope.origin.clientSeq);
      clearTimeout(waiter.timer);
      if (envelope.rejectionReason) waiter.reject(new AhpError(`the host refused ${envelope.action.type}: ${envelope.rejectionReason}`));
      else waiter.resolve();
    }
    failWaiters(new AhpError('connection closed'));
  })();
  pump.catch(() => undefined);

  client.connect();
  let init: InitializeResult;
  try {
    init = await client.initialize({
      clientId: options.clientId,
      protocolVersions: [...(options.protocolVersions ?? PROTOCOL_VERSIONS)],
      initialSubscriptions: [ROOT],
    });
  } catch (error) {
    await client.shutdown().catch(() => undefined);
    if (error instanceof RpcError && error.code === UNSUPPORTED_PROTOCOL_VERSION) {
      const supported = (error.data as { supportedVersions?: unknown } | undefined)?.supportedVersions;
      throw new AhpError(
        `unsupported protocol version: the operator offers ${(options.protocolVersions ?? PROTOCOL_VERSIONS).join(', ')}, the host speaks ${Array.isArray(supported) ? supported.join(', ') : 'something else'}`,
        { unsupportedVersion: true, cause: error },
      );
    }
    throw new AhpError(`initialize: ${errorMessage(error)}`, { cause: error });
  }
  for (const snapshot of init.snapshots) mirror.applySnapshot(snapshot);

  let catalog: Promise<void> | undefined;
  const subscribeCatalog = () =>
    (catalog ??= client.subscribe(AUTOMATIONS).then(
      ({ result }) => {
        if (result.snapshot) mirror.applySnapshot(result.snapshot);
      },
      (error) => {
        catalog = undefined;
        throw new AhpError(`subscribing to ${AUTOMATIONS}: ${errorMessage(error)}`, { cause: error });
      },
    ));

  // Dispatches an action and waits for the host to echo it back.
  const dispatch = (action: StateAction) =>
    new Promise<void>((resolve, reject) => {
      let seq: number;
      try {
        seq = client.dispatch(AUTOMATIONS, action).clientSeq;
      } catch (error) {
        reject(new AhpError(`${action.type}: ${errorMessage(error)}`, { cause: error }));
        return;
      }
      const timer = setTimeout(() => {
        waiters.delete(seq);
        reject(new AhpError(`${action.type}: no answer within ${timeoutMs / 1000}s`));
      }, timeoutMs);
      waiters.set(seq, { resolve, reject, timer });
    });

  const serverInfo = init.serverInfo ? `${init.serverInfo.name} ${init.serverInfo.version}`.trim() : null;
  return {
    protocolVersion: init.protocolVersion,
    serverInfo,
    automations: init.automations?.create !== undefined,
    agents: () => (mirror.root?.agents ?? []).map((a) => a.provider),
    alive: () => client.connectionState.status === 'connected',
    ping: () => client.ping(),
    list: async (path) => {
      try {
        return (await client.resourceList({ uri: fileUri(path) })).entries;
      } catch (error) {
        // The host answered, with an error: nothing there to list. A broken
        // connection is something else, and is thrown.
        if (error instanceof RpcError) return null;
        throw error;
      }
    },
    remove: async (path) => {
      try {
        await client.resourceDelete({ uri: fileUri(path), recursive: true });
      } catch (error) {
        if (error instanceof RpcError && (await client.resourceList({ uri: fileUri(path) }).then(() => false, () => true))) return;
        throw error;
      }
    },
    automationCatalog: async () => {
      await subscribeCatalog();
      return [...mirror.automations.values()];
    },
    createAutomation: async (resource, definition) => {
      await subscribeCatalog();
      await dispatch({ type: 'automation/createRequested', resource, definition } as unknown as StateAction);
    },
    updateAutomation: async (resource, changes) => {
      await subscribeCatalog();
      await dispatch({ type: 'automation/updateRequested', resource, changes } as unknown as StateAction);
    },
    removeAutomation: async (resource) => {
      await subscribeCatalog();
      await dispatch({ type: 'automation/removed', resource } as unknown as StateAction);
    },
    close: () => {
      failWaiters(new AhpError('connection closed'));
      client.shutdown().catch(() => undefined);
    },
  };
}

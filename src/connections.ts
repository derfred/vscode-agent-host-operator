// The AHP connections, one per pod, kept open from pass to pass. Each pass
// pings the ones it uses, to notice a dead one, and replaces a connection
// whose pod, address or token changed (a restarted pod, a rotated Secret). A
// pod that can't be reached is tried again with backoff, so a broken host
// costs one attempt per backoff, not one per pass.

import { createHash } from 'node:crypto';
import type { AgentHost } from './ahp.ts';

export const MIN_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 5 * 60 * 1000;

export interface Target {
  readonly uid: string;
  readonly url: string;
}

interface Entry {
  readonly key: string;
  host?: AgentHost;
  failedAt?: number;
  backoffMs: number;
  error?: Error;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
// The URL carries the token; only its hash is kept for comparison.
const keyOf = (target: Target) => `${target.uid}|${createHash('sha256').update(target.url).digest('hex')}`;

export class Connections {
  readonly #entries = new Map<string, Entry>();
  readonly #connect: (url: string) => Promise<AgentHost>;
  readonly #now: () => number;

  constructor(options: { readonly connect: (url: string) => Promise<AgentHost>; readonly now?: () => number }) {
    this.#connect = options.connect;
    this.#now = options.now ?? Date.now;
  }

  // A live connection to the pod, or an error saying why there is none.
  async get(pod: string, target: Target): Promise<AgentHost> {
    const key = keyOf(target);
    let entry = this.#entries.get(pod);
    if (entry && entry.key !== key) {
      entry.host?.close();
      entry = undefined;
    }
    if (entry?.host) {
      try {
        if (!entry.host.alive()) throw new Error('connection closed');
        await entry.host.ping();
        return entry.host;
      } catch (error) {
        entry.host.close();
        entry.host = undefined;
        entry.error = new Error(`connection lost: ${errorMessage(error)}`);
        // Reconnect at once: it was up a moment ago.
        entry.failedAt = undefined;
        entry.backoffMs = 0;
      }
    }
    entry ??= { key, backoffMs: 0 };
    this.#entries.set(pod, entry);
    if (entry.failedAt !== undefined && this.#now() - entry.failedAt < entry.backoffMs) {
      const seconds = Math.ceil((entry.backoffMs - (this.#now() - entry.failedAt)) / 1000);
      throw new Error(`${entry.error?.message ?? 'not connected'} (retrying in ${seconds}s)`);
    }
    try {
      entry.host = await this.#connect(target.url);
      entry.failedAt = undefined;
      entry.backoffMs = 0;
      entry.error = undefined;
      return entry.host;
    } catch (error) {
      entry.failedAt = this.#now();
      entry.backoffMs = Math.min(Math.max(entry.backoffMs * 2, MIN_BACKOFF_MS), MAX_BACKOFF_MS);
      entry.error = error instanceof Error ? error : new Error(String(error));
      throw entry.error;
    }
  }

  // Closes and forgets the connections of pods not in `pods` (by name).
  retain(pods: ReadonlySet<string>): void {
    for (const [pod, entry] of this.#entries) {
      if (pods.has(pod)) continue;
      entry.host?.close();
      this.#entries.delete(pod);
    }
  }

  closeAll(): void {
    this.retain(new Set());
  }
}

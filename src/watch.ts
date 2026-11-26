// Kubernetes watches as a wake-up signal. Each watch lists once for a
// resourceVersion, then streams changes from it and calls onChange for every
// one; the reconcile pass reads everything afresh, so no cache is kept. The
// API server ends watches every few minutes by design, so the loop resumes
// from the last version it saw, and lists again when that version has
// expired (410 Gone).

export type Get = (path: string, signal: AbortSignal) => Promise<Response>;

export interface WatchOptions {
  readonly get: Get;
  // A collection path, query allowed: /api/v1/namespaces/x/pods?labelSelector=...
  readonly path: string;
  readonly onChange: () => void;
  readonly signal: AbortSignal;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
  readonly sleep?: (ms: number) => Promise<void>;
}

// Asked of the server; a stream silent for longer than this plus a margin is
// assumed dead (bookmarks arrive well within it).
export const WATCH_TIMEOUT_SECONDS = 300;
const IDLE_MS = (WATCH_TIMEOUT_SECONDS + 60) * 1000;
const MAX_BACKOFF_MS = 30_000;

class Gone extends Error {}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Newline-delimited JSON from a streamed body. `onData` fires per chunk, for
// the idle watchdog.
async function* events(body: ReadableStream<Uint8Array>, onData: () => void) {
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of body) {
    onData();
    buffered += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line.length > 0) yield JSON.parse(line);
    }
  }
}

export async function watch(options: WatchOptions): Promise<void> {
  const { get, path, onChange, signal } = options;
  const log = options.log ?? (() => undefined);
  const sleep = options.sleep ?? defaultSleep;
  const sep = path.includes('?') ? '&' : '?';
  let resourceVersion: string | undefined;
  let backoff = 1000;

  while (!signal.aborted) {
    const idle = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => idle.abort(), IDLE_MS);
    };
    try {
      if (resourceVersion === undefined) {
        const list = await get(path, signal);
        if (!list.ok) throw new Error(`list ${path}: HTTP ${list.status}`);
        resourceVersion = ((await list.json()) as any).metadata.resourceVersion;
        // Whatever happened while unwatched is unknown: treat it as a change.
        onChange();
      }
      touch();
      const url = `${path}${sep}watch=1&allowWatchBookmarks=true&timeoutSeconds=${WATCH_TIMEOUT_SECONDS}&resourceVersion=${resourceVersion}`;
      const response = await get(url, AbortSignal.any([signal, idle.signal]));
      if (response.status === 410) throw new Gone();
      if (!response.ok || !response.body) throw new Error(`watch ${path}: HTTP ${response.status}`);
      backoff = 1000;
      for await (const event of events(response.body, touch)) {
        if (event.type === 'ERROR') {
          if (event.object?.code === 410) throw new Gone();
          throw new Error(`watch ${path}: ${event.object?.message ?? JSON.stringify(event.object)}`);
        }
        resourceVersion = event.object?.metadata?.resourceVersion ?? resourceVersion;
        if (event.type !== 'BOOKMARK') onChange();
      }
      // A clean end is the server's timeout: resume from resourceVersion.
    } catch (error) {
      if (signal.aborted) break;
      if (error instanceof Gone) {
        resourceVersion = undefined;
        continue;
      }
      log('watch failed; retrying', { path, error: String(error), backoffMs: backoff });
      await sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    } finally {
      clearTimeout(timer);
    }
  }
}

// Wakes the reconcile loop: on a change, or when its timeout runs out.
// Changes that arrive together (or during a pass) make one wake-up: a pass
// reads everything anyway.
export class Trigger {
  #pending = false;
  #waiter: (() => void) | undefined;
  readonly #debounceMs: number;

  constructor(debounceMs = 500) {
    this.#debounceMs = debounceMs;
  }

  notify() {
    this.#pending = true;
    this.#waiter?.();
  }

  // Resolves to true if woken by a change, false on timeout or abort.
  async wait(timeoutMs: number, signal: AbortSignal): Promise<boolean> {
    if (!this.#pending && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', done);
          this.#waiter = undefined;
          resolve();
        };
        const timer = setTimeout(done, timeoutMs);
        signal.addEventListener('abort', done);
        this.#waiter = done;
      });
    }
    const woken = this.#pending;
    if (woken && !signal.aborted) await new Promise((resolve) => setTimeout(resolve, this.#debounceMs));
    this.#pending = false;
    return woken;
  }
}

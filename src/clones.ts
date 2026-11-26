// The clones of workspaces, which outlive a reconcile pass.
//
// AHP can read and write files but has no clone call, so a workspace is
// cloned with `git clone` run in the host's container over pods/exec, as the
// pod's user, with the pod's git credentials. The exec answers only once git
// is done, so each clone is an exec of its own, kept here between passes, and
// a pass reads where it stands. Clones live in memory only: after an
// operator restart the next pass finds the folder (git done) or not (git
// stopped, or still running), and starts again where it needs to.

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

// How long one clone may take before the exec gives up on it.
export const CLONE_TIMEOUT_MS = 60 * 60 * 1000;

export type Exec = (pod: string, container: string, command: ReadonlyArray<string>, options?: { readonly timeoutMs?: number }) => Promise<string>;

export interface CloneJob {
  readonly repository: string;
  readonly ref: string | null;
  // The pod the clone runs in: a restarted pod ended it.
  readonly podUID: string;
  readonly phase: 'running' | 'done' | 'failed';
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly error: string | null;
  // Done without cloning: the folder already held files, which are kept.
  readonly existing: boolean;
}

export interface CloneRequest {
  readonly host: string;
  readonly podUID: string;
  readonly container: string;
  readonly path: string;
  readonly repository: string;
  readonly ref?: string | null;
}

// The command a clone runs. `--` ends the options: a repository is never
// taken for one.
export function cloneCommand(request: Pick<CloneRequest, 'path' | 'repository' | 'ref'>): string[] {
  return ['git', 'clone', ...(request.ref ? ['--branch', request.ref] : []), '--', request.repository, request.path];
}

export class Clones {
  readonly #jobs = new Map<string, { job: CloneJob; settled: Promise<void> }>();
  readonly #exec: Exec;
  readonly #now: () => Date;
  // How long `start` waits for a quick answer, such as a folder that already
  // has files, so that it shows in the same pass.
  readonly #quickMs: number;
  // Called when a clone ends, to run a pass that records it.
  readonly #onEnd: () => void;

  constructor(options: { readonly exec: Exec; readonly now?: () => Date; readonly quickMs?: number; readonly onEnd?: () => void }) {
    this.#exec = options.exec;
    this.#now = options.now ?? (() => new Date());
    this.#quickMs = options.quickMs ?? 2_000;
    this.#onEnd = options.onEnd ?? (() => undefined);
  }

  get(host: string, path: string): CloneJob | undefined {
    return this.#jobs.get(key(host, path))?.job;
  }

  forget(host: string, path: string): void {
    this.#jobs.delete(key(host, path));
  }

  // Forgets the clones of hosts not in `hosts` (by pod name).
  retain(hosts: ReadonlySet<string>): void {
    for (const id of this.#jobs.keys()) if (!hosts.has(id.split('\u0000')[0]!)) this.#jobs.delete(id);
  }

  running(): boolean {
    return [...this.#jobs.values()].some((e) => e.job.phase === 'running');
  }

  // Starts a clone and waits briefly for it. Resolves to the job as it then
  // stands.
  async start(request: CloneRequest): Promise<CloneJob> {
    const id = key(request.host, request.path);
    const running = this.#jobs.get(id);
    if (running?.job.phase === 'running' && running.job.podUID === request.podUID) return running.job;
    const entry = {
      job: {
        repository: request.repository,
        ref: request.ref ?? null,
        podUID: request.podUID,
        phase: 'running',
        startedAt: this.#now().toISOString(),
        endedAt: null,
        error: null,
        existing: false,
      } as CloneJob,
      settled: Promise.resolve(),
    };
    const end = (fields: Partial<CloneJob>) => {
      // A later start (a forget, then a new clone) owns the entry now.
      if (this.#jobs.get(id) === entry) entry.job = { ...entry.job, endedAt: this.#now().toISOString(), ...fields };
    };
    entry.settled = this.#exec(request.host, request.container, cloneCommand(request), { timeoutMs: CLONE_TIMEOUT_MS })
      .then(
        () => end({ phase: 'done' }),
        (error) =>
          // Files there already: a checkout from before or one made by hand.
          // Kept as they are.
          /already exists and is not an empty directory/i.test(errorMessage(error))
            ? end({ phase: 'done', existing: true })
            : end({ phase: 'failed', error: errorMessage(error) }),
      )
      .finally(() => this.#onEnd());
    this.#jobs.set(id, entry);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([entry.settled, new Promise<void>((resolve) => (timer = setTimeout(resolve, this.#quickMs)))]);
    clearTimeout(timer);
    return entry.job;
  }

  // Every clone still running, settled. For tests.
  async settled(): Promise<void> {
    await Promise.all([...this.#jobs.values()].map((e) => e.settled));
  }
}

const key = (host: string, path: string) => `${host}\u0000${path}`;

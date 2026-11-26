// Agent hosts for the end-to-end test, each standing in for one pod: a real
// `code agent host`, either in Docker (the host image) or as a process on
// this machine (the VS Code CLI on the PATH, or --code).
//
// Each host has its own state (--server-data-dir: sessions and the
// automation catalogue) and endpoint registry (--user-data-dir), as a pod
// has its own home volume, and keeps them across restart(), as a pod keeps
// its volume. Process hosts share one --cli-data-dir, so the server is
// downloaded once.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, openSync } from 'node:fs';
import { join } from 'node:path';

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface Host {
  readonly name: string;
  // What the operator dials, as the pod IP.
  readonly ip: string;
  readonly port: number;
  // Where the repository to clone is, as the host sees it.
  readonly remote: string;
  // A folder the host can clone into: workspaces go under it.
  readonly workspaceRoot: string;
  // Runs a command where the operator's exec would: in the host.
  exec(command: string[]): Promise<ExecResult>;
  // Until it accepts WebSocket connections.
  ready(): Promise<void>;
  restart(): Promise<void>;
  stop(): void;
  logs(): string;
}

const sh = (cmd: string, argv: string[]) =>
  execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Runs a command to its end: its output and exit code, never a throw.
export const runCommand = (argv: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<ExecResult> =>
  new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (error) => resolve({ stdout, stderr: String(error), exitCode: 127 }));
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
  });

async function waitForPort(ip: string, port: number, timeoutMs: number, alive: () => string | null) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const dead = alive();
    if (dead) throw new Error(dead);
    // The host answers a plain HTTP request on its WebSocket port.
    const ok = await fetch(`http://${ip}:${port}/`, { signal: AbortSignal.timeout(2000) }).then(
      () => true,
      () => false,
    );
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`nothing listening on ${ip}:${port} after ${timeoutMs / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// A bare repository with one commit at `remote`, made with the host's git.
const SEED_REPOSITORY = (remote: string, scratch: string) =>
  [
    'set -eu',
    `rm -rf ${scratch} ${remote}`,
    `git init -q -b main ${scratch}`,
    `cd ${scratch} && echo e2e > README.md && git add README.md`,
    'git -c user.name=e2e -c user.email=e2e@example.com commit -qm init',
    `git clone -q --bare ${scratch} ${remote}`,
  ].join('\n');

// ─── as a process ────────────────────────────────────────────────────────────

export interface ProcessHostOptions {
  readonly name: string;
  // A loopback address of its own (127.0.0.N), so every host can use the
  // set's one port, as pods do.
  readonly ip: string;
  readonly port: number;
  readonly tokenFile: string;
  readonly code: string;
  readonly work: string;
  readonly cliDataDir: string;
}

export async function processHost(options: ProcessHostOptions): Promise<Host> {
  const home = join(options.work, options.name);
  const workspaceRoot = join(home, 'workspace');
  for (const dir of [home, workspaceRoot]) mkdirSync(dir, { recursive: true });
  const log = join(home, 'host.log');
  let child: ChildProcess | undefined;
  let exited: string | null = null;

  const start = () => {
    exited = null;
    const out = openSync(log, 'a');
    child = spawn(
      options.code,
      [
        'agent', 'host', '--foreground',
        '--host', options.ip, '--port', String(options.port),
        '--connection-token-file', options.tokenFile,
        '--server-data-dir', join(home, 'server-data'),
        '--user-data-dir', join(home, 'user-data'),
        '--cli-data-dir', options.cliDataDir,
      ],
      { env: { ...process.env, HOME: home }, stdio: ['ignore', out, out], detached: true },
    );
    child.on('exit', (code, signal) => (exited = `${options.name} exited (${code ?? signal}); see ${log}`));
  };
  const stop = () => {
    if (!child || child.exitCode !== null) return;
    // The supervisor and the server it started: the whole process group.
    try {
      process.kill(-child.pid!, 'SIGTERM');
    } catch {}
  };
  const stopped = () =>
    new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', () => resolve());
      setTimeout(() => {
        try {
          process.kill(-child!.pid!, 'SIGKILL');
        } catch {}
      }, 10_000);
    });

  const remote = join(home, 'origin.git');
  const seeded = await runCommand(['sh', '-c', SEED_REPOSITORY(remote, join(home, 'seed'))]);
  if (seeded.exitCode !== 0) throw new Error(`seeding ${remote}: ${seeded.stderr}`);
  start();
  const host: Host = {
    name: options.name,
    ip: options.ip,
    port: options.port,
    remote,
    workspaceRoot,
    exec: (command) => runCommand(command, { env: { ...process.env, HOME: home } }),
    ready: () => waitForPort(options.ip, options.port, 180_000, () => exited),
    restart: async () => {
      stop();
      await stopped();
      start();
      await host.ready();
    },
    stop,
    logs: () => sh('tail', ['-n', '60', log]),
  };
  return host;
}

// ─── in Docker ───────────────────────────────────────────────────────────────

export interface DockerHostOptions {
  readonly name: string;
  readonly image: string;
  readonly port: number;
  // The token, as the pod mounts its Secret: a file in a read-only folder.
  readonly tokenDir: string;
}

const docker = (...argv: string[]) => sh('docker', argv);

export async function dockerHost(options: DockerHostOptions): Promise<Host> {
  const { name, image, port } = options;
  docker('volume', 'create', `${name}-home`);
  docker('volume', 'create', `${name}-workspace`);
  docker(
    'run', '-d', '--name', name,
    // As the StatefulSet mounts them: home (state) and /workspace.
    '-v', `${name}-home:/home/node`,
    '-v', `${name}-workspace:/workspace`,
    '-v', `${options.tokenDir}:/etc/agent-host:ro`,
    image,
    '--host', '0.0.0.0', '--port', String(port),
    '--connection-token-file', '/etc/agent-host/token',
    '--server-data-dir', '/home/node/.vscode-server',
  );
  const ip = docker('inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name);
  const running = () => (docker('inspect', '-f', '{{.State.Running}}', name) === 'true' ? null : `${name} stopped: ${sh('docker', ['logs', '--tail', '30', name])}`);
  const exec = (command: string[]) => runCommand(['docker', 'exec', name, ...command]);
  const remote = '/home/node/origin.git';
  const host: Host = {
    name,
    ip,
    port,
    remote,
    workspaceRoot: '/workspace',
    exec,
    ready: () => waitForPort(ip, port, 180_000, running),
    restart: async () => {
      docker('restart', '-t', '10', name);
      await host.ready();
    },
    stop: () => {
      for (const argv of [['rm', '-f', name], ['volume', 'rm', '-f', `${name}-home`, `${name}-workspace`]]) {
        try {
          docker(...argv);
        } catch {}
      }
    },
    logs: () => sh('docker', ['logs', '--tail', '60', name]),
  };
  const seeded = await exec(['sh', '-c', SEED_REPOSITORY(remote, '/home/node/seed')]);
  if (seeded.exitCode !== 0) throw new Error(`seeding ${remote}: ${seeded.stderr}`);
  return host;
}

export function writeToken(dir: string, token: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'token'), token, { mode: 0o644 });
}

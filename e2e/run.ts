// Stage 2 of docs/testing.md: the end-to-end scenario (e2e/scenario.ts)
// against a fake Kubernetes API server (in this process), two real agent
// hosts standing in for the pods of a StatefulSet, and the operator.
//
//   node e2e/run.ts [--hosts docker|process] [--operator docker|process]
//                   [--host-image IMAGE] [--operator-image IMAGE] [--code PATH]
//
// --hosts docker (the default): the host image, built from
//   examples/agent-host-image unless --host-image names one, run as two
//   containers with their own volumes.
// --hosts process: `code agent host` on this machine (--code, default `code`
//   on the PATH), on 127.0.0.2 and 127.0.0.3. Both share this machine's
//   filesystem, so a workspace path is the same folder on both.
// --operator docker (the default): the image built from this checkout's
//   Dockerfile unless --operator-image names one, on the host network, with
//   what a cluster gives it: KUBERNETES_SERVICE_HOST/PORT and a
//   service-account token and CA at /var/run/secrets/kubernetes.io/serviceaccount.
// --operator process: `node src/main.ts`, with KUBE_SERVICE_ACCOUNT_DIR.
//
// The fake API server answers pods/exec by running the command in the host
// (`docker exec`, or here for process hosts).

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { FakeApiServer } from './fake-apiserver.ts';
import { dockerHost, processHost, writeToken, type Host } from './hosts.ts';
import { NAMESPACE, run, type Context } from './scenario.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    hosts: { type: 'string', default: 'docker' },
    operator: { type: 'string', default: 'docker' },
    'host-image': { type: 'string' },
    'operator-image': { type: 'string' },
    code: { type: 'string', default: 'code' },
    port: { type: 'string', default: '8081' },
  },
});

const sh = (cmd: string, argv: string[], options: { cwd?: string; quiet?: boolean } = {}) =>
  execFileSync(cmd, argv, { cwd: options.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', options.quiet ? 'pipe' : 'inherit'] }).trim();
const docker = (...argv: string[]) => sh('docker', argv);
const log = (message: string) => console.log(`e2e: ${message}`);

const work = mkdtempSync(join(tmpdir(), 'agent-host-operator-e2e-'));
chmodSync(work, 0o755);
const cleanups: Array<() => void> = [];
const diagnostics: Array<() => void> = [];
const id = `${process.pid}`;
const port = Number(args.port);

// On GitHub Actions, also as an annotation, readable through the API.
function report(title: string, text: string) {
  console.error(`--- ${title}\n${text}`);
  if (!process.env.GITHUB_ACTIONS) return;
  const escaped = text.slice(-12_000).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::error title=e2e ${title}::${escaped}`);
}

// A CA, and a certificate for the fake API server signed by it.
function certificates() {
  const ssl = (...argv: string[]) => sh('openssl', argv, { cwd: work, quiet: true });
  ssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', '/CN=e2e-ca', '-keyout', 'ca.key', '-out', 'ca.crt');
  ssl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-subj', '/CN=kubernetes',
    '-keyout', 'server.key', '-out', 'server.csr');
  writeFileSync(join(work, 'san.ext'), 'subjectAltName=DNS:kubernetes,IP:127.0.0.1\n');
  ssl('x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1',
    '-extfile', 'san.ext', '-out', 'server.crt');
  return { ca: join(work, 'ca.crt'), key: readFileSync(join(work, 'server.key'), 'utf8'), cert: readFileSync(join(work, 'server.crt'), 'utf8') };
}

async function startHosts(token: string): Promise<Host[]> {
  const tokenDir = join(work, 'host-token');
  writeToken(tokenDir, token);
  chmodSync(tokenDir, 0o755);
  if (args.hosts === 'process') {
    const cliDataDir = join(work, 'cli');
    const hosts = [];
    for (const [i, ip] of ['127.0.0.2', '127.0.0.3'].entries()) {
      const host = await processHost({ name: `agents-e2e-${i}`, ip, port, tokenFile: join(tokenDir, 'token'), code: args.code!, work, cliDataDir });
      cleanups.push(() => host.stop());
      diagnostics.push(() => report(`${host.name} log`, host.logs()));
      hosts.push(host);
      // One at a time: the first downloads the server for both.
      log(`${host.name}: code agent host on ${ip}:${port}`);
      await host.ready();
    }
    return hosts;
  }
  const image = args['host-image'] ?? 'agent-host-operator-e2e-host';
  if (!args['host-image']) {
    log('building the host image (examples/agent-host-image)');
    docker('build', '-q', '-t', image, join(root, 'examples/agent-host-image'));
  }
  const hosts: Host[] = [];
  for (const i of [0, 1]) {
    const host = await dockerHost({ name: `agents-e2e-${i}-${id}`, image, port, tokenDir });
    cleanups.push(() => host.stop());
    diagnostics.push(() => report(`${host.name} logs`, host.logs()));
    hosts.push(host);
  }
  for (const host of hosts) {
    await host.ready();
    log(`${host.name}: ${image} on ${host.ip}:${port}`);
  }
  return hosts;
}

// Starts the operator; returns a function that restarts it.
function startOperator(apiPort: number, ca: string): () => Promise<void> {
  const sa = join(work, 'serviceaccount');
  mkdirSync(sa);
  writeFileSync(join(sa, 'token'), 'e2e-service-account-token');
  writeFileSync(join(sa, 'ca.crt'), readFileSync(ca));
  writeFileSync(join(sa, 'namespace'), NAMESPACE);
  chmodSync(sa, 0o755);
  for (const f of ['token', 'ca.crt', 'namespace']) chmodSync(join(sa, f), 0o644);
  const env = {
    NAMESPACE,
    KUBERNETES_SERVICE_HOST: '127.0.0.1',
    KUBERNETES_SERVICE_PORT: String(apiPort),
    CLONING_POLL_SECONDS: '1',
  };

  if (args.operator === 'process') {
    let child: ChildProcess;
    const start = () => {
      child = spawn(process.execPath, [join(root, 'src/main.ts')], {
        env: { ...process.env, ...env, KUBE_SERVICE_ACCOUNT_DIR: sa, NODE_EXTRA_CA_CERTS: ca },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout!.on('data', (d) => process.stdout.write(`${d}`.replace(/^/gm, 'operator: ')));
      child.stderr!.on('data', (d) => process.stderr.write(`${d}`.replace(/^/gm, 'operator: ')));
    };
    start();
    cleanups.push(() => child.kill());
    log('operator: node src/main.ts');
    return async () => {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
      start();
    };
  }

  const image = args['operator-image'] ?? 'agent-host-operator:e2e';
  if (!args['operator-image']) {
    log('building the operator image (Dockerfile)');
    docker('build', '-q', '-t', image, root);
  }
  const name = `agent-host-operator-e2e-${id}`;
  // The host network: the fake API server is on 127.0.0.1 here, and the
  // hosts' container addresses are reachable from it, as pod IPs are.
  docker('run', '-d', '--name', name, '--network', 'host',
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    '-v', `${sa}:/var/run/secrets/kubernetes.io/serviceaccount:ro`,
    image);
  cleanups.push(() => sh('docker', ['rm', '-f', name], { quiet: true }));
  diagnostics.push(() => report('operator logs', sh('docker', ['logs', '--tail', '150', name], { quiet: true })));
  log(`operator: ${image}`);
  return async () => {
    docker('restart', '-t', '10', name);
  };
}

const api = new FakeApiServer();
let ok = false;
try {
  if (args.operator === 'docker' && args.hosts === 'process') {
    throw new Error('--operator docker needs --hosts docker: it cannot reach hosts on this machine\'s 127.0.0.x');
  }
  const { ca, key, cert } = certificates();
  const apiPort = await api.listen({ key, cert, host: '127.0.0.1' });
  log(`fake Kubernetes API server on 127.0.0.1:${apiPort}`);
  const token = `e2e-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  const hosts = await startHosts(token);
  api.exec = async (pod, _container, command) => {
    const host = hosts.find((h) => h.name === pod);
    if (!host) throw new Error(`no host for pod ${pod}`);
    return host.exec(command);
  };
  const restartOperator = startOperator(apiPort, ca);
  const context: Context = { api, hosts, token, restartOperator };
  await run(context);
  ok = true;
  log('passed');
} catch (error) {
  report('FAILED', error instanceof Error ? (error.stack ?? error.message) : String(error));
  for (const plural of ['agenthostsets', 'agentworkspaces', 'agentautomations']) {
    const items = api.list(`/apis/agenthost.derfred.com/v1alpha1/namespaces/${NAMESPACE}/${plural}`);
    report(plural, JSON.stringify(items.map((o) => ({ name: o.metadata.name, status: o.status })), null, 1));
  }
} finally {
  for (const step of [...(ok ? [] : diagnostics), ...cleanups.reverse()]) {
    try {
      step();
    } catch {}
  }
  await api.close();
  rmSync(work, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);

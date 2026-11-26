// Writes deploy/install.yaml from deploy/render.jsonnet (the library in
// deploy/jsonnet). With --check, writes nothing and fails if it is stale.
// Needs a jsonnet binary: `jsonnet` on the PATH, or $JSONNET.
//
//   npm run render [-- --check]

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const deploy = dirname(fileURLToPath(import.meta.url));
const check = process.argv.includes('--check');
const outputs = ['install.yaml'];

// The library's version is the release's: package.json's.
const pkg = JSON.parse(readFileSync(join(deploy, '..', 'package.json'), 'utf8')).version;
const lib = JSON.parse(readFileSync(join(deploy, 'jsonnet', 'version.json'), 'utf8')).version;
if (pkg !== lib) {
  console.error(`deploy/jsonnet/version.json says ${lib}, package.json ${pkg}: keep them equal`);
  process.exit(1);
}

const out = mkdtempSync(join(tmpdir(), 'agent-host-operator-render-'));
try {
  execFileSync(process.env.JSONNET ?? 'jsonnet', ['-S', '-m', out, join(deploy, 'render.jsonnet')], { stdio: ['ignore', 'ignore', 'inherit'] });
  const stale = outputs.filter((f) => {
    // One final newline, whichever jsonnet wrote it (versions differ).
    const fresh = readFileSync(join(out, f), 'utf8').trimEnd() + '\n';
    let current = '';
    try {
      current = readFileSync(join(deploy, f), 'utf8');
    } catch {}
    if (fresh === current) return false;
    if (!check) writeFileSync(join(deploy, f), fresh);
    return true;
  });
  if (check && stale.length > 0) {
    console.error(`stale: ${stale.map((f) => `deploy/${f}`).join(', ')}. Run \`npm run render\` and commit the result.`);
    process.exit(1);
  }
  console.log(check ? 'deploy/ is up to date' : stale.length ? `wrote ${stale.map((f) => `deploy/${f}`).join(', ')}` : 'deploy/ was up to date');
} finally {
  rmSync(out, { recursive: true, force: true });
}

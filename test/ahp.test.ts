import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AutomationDefinition } from '@microsoft/agent-host-protocol';
import { AhpError, fileUri, hostUrl, openHost } from '../src/ahp.ts';
import { FakeHost } from './fake-host.ts';

const definition = (title: string) =>
  ({
    title,
    message: { text: 'check dependencies', origin: { kind: 'automation' } },
    session: { workingDirectories: ['file:///workspace/my-app'] },
    enabled: true,
    triggers: [],
  }) as unknown as AutomationDefinition;

const open = (fake: FakeHost, protocolVersions?: string[]) =>
  openHost(fake.client, { clientId: 'operator', requestTimeoutMs: 2_000, ...(protocolVersions ? { protocolVersions } : {}) });

describe('hostUrl and fileUri', () => {
  it('puts the token in tkn, escaped, and brackets an IPv6 address', () => {
    assert.equal(hostUrl('10.0.0.7', 8081, 'a+b/c'), 'ws://10.0.0.7:8081/?tkn=a%2Bb%2Fc');
    assert.equal(hostUrl('fd00::7', 8081, 't'), 'ws://[fd00::7]:8081/?tkn=t');
  });
  it('makes file URIs of absolute paths', () => {
    assert.equal(fileUri('/workspace/my app'), 'file:///workspace/my%20app');
  });
});

describe('openHost', () => {
  it('agrees a version and reads the agents from the root snapshot', async () => {
    const host = await open(new FakeHost({ agents: ['claude', 'codex'] }));
    assert.equal(host.protocolVersion, '1.1.0');
    assert.equal(host.serverInfo, 'fake-host 0.0.1');
    assert.deepEqual(host.agents(), ['claude', 'codex']);
    assert.equal(host.automations, true);
    assert.equal(host.alive(), true);
    await host.ping();
    host.close();
  });

  it('says when the host speaks no version the operator offers', async () => {
    await assert.rejects(open(new FakeHost({ protocolVersions: ['2.0.0'] })), (error: unknown) => {
      assert.ok(error instanceof AhpError);
      assert.equal(error.unsupportedVersion, true);
      assert.match(error.message, /the host speaks 2\.0\.0/);
      return true;
    });
  });

  it('lists a folder, and answers null for one that does not exist', async () => {
    const host = await open(new FakeHost({ files: { '/workspace/my-app': ['README.md', '.git'] } }));
    assert.deepEqual((await host.list('/workspace/my-app'))?.map((e) => e.name), ['README.md', '.git']);
    assert.equal(await host.list('/workspace/other'), null);
    host.close();
  });

  it('removes a folder, and a missing one quietly', async () => {
    const fake = new FakeHost({ files: { '/workspace/my-app': ['README.md'] } });
    const host = await open(fake);
    await host.remove('/workspace/my-app');
    assert.equal(fake.files.has('/workspace/my-app'), false);
    await host.remove('/workspace/my-app');
    host.close();
  });

  for (const [style, echo] of [['publishing the result, as VS Code 1.148 does', false], ['echoing the action, as the spec has it', true]] as const) {
  it(`creates, updates and removes automations, waiting for the host to take each (${style})`, async () => {
    const fake = new FakeHost({ echo });
    const host = await open(fake);
    assert.deepEqual(await host.automationCatalog(), []);
    await host.createAutomation('ahp-automation:/k8s-deps', definition('deps'));
    assert.deepEqual((await host.automationCatalog()).map((e) => [e.resource, e.definition.title]), [['ahp-automation:/k8s-deps', 'deps']]);
    await host.updateAutomation('ahp-automation:/k8s-deps', { title: 'dependencies' });
    assert.equal(fake.catalog.get('ahp-automation:/k8s-deps')?.definition.title, 'dependencies');
    await host.removeAutomation('ahp-automation:/k8s-deps');
    assert.equal(fake.catalog.size, 0);
    assert.deepEqual(await host.automationCatalog(), []);
    host.close();
  });
  }

  it('reads and turns on the host’s automationsEnabled setting', async () => {
    const fake = new FakeHost();
    const host = await open(fake);
    assert.equal(host.automationsEnabled(), false);
    await host.enableAutomations();
    assert.equal(fake.automationsEnabled, true);
    assert.equal(host.automationsEnabled(), true);
    host.close();
  });

  it('reports an action the host refused', async () => {
    const host = await open(new FakeHost({ reject: 'schedule too frequent' }));
    await assert.rejects(host.createAutomation('ahp-automation:/k8s-deps', definition('deps')), /refused automation\/createRequested: schedule too frequent/);
    host.close();
  });

  it('reports a host without an automation catalogue', async () => {
    const host = await open(new FakeHost({ automations: false }));
    assert.equal(host.automations, false);
    host.close();
  });
});

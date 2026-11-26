// The operator's CustomResourceDefinitions, in deploy/install.yaml.
// Their schemas follow what src/reconcile.ts reads; change both together.
local group = 'agenthost.derfred.com';

local string(description=null) = { type: 'string' } + (if description == null then {} else { description: description });
local enum(values, default=null, description=null) =
  string(description) { enum: values } + (if default == null then {} else { default: default });
// An object t3 defines: passed through to it as it is.
local opaque(description) = { type: 'object', description: description, 'x-kubernetes-preserve-unknown-fields': true };

// metav1.LabelSelector, as src/selector.ts implements it.
local labelSelector(description) = {
  type: 'object',
  description: description,
  properties: {
    matchLabels: { type: 'object', additionalProperties: { type: 'string' } },
    matchExpressions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['key', 'operator'],
        properties: {
          key: string(),
          operator: enum(['In', 'NotIn', 'Exists', 'DoesNotExist']),
          values: { type: 'array', items: string() },
        },
      },
    },
  },
};

// A namespaced kind at v1alpha1 with a status subresource. `spec` is the
// spec's schema; status is the operator's own and not validated.
local crd(kind, spec, columns) = {
  local plural = std.asciiLower(kind) + 's',
  apiVersion: 'apiextensions.k8s.io/v1',
  kind: 'CustomResourceDefinition',
  metadata: { name: plural + '.' + group },
  spec: {
    group: group,
    names: {
      kind: kind,
      listKind: kind + 'List',
      plural: plural,
      singular: std.asciiLower(kind),
    },
    scope: 'Namespaced',
    versions: [{
      name: 'v1alpha1',
      served: true,
      storage: true,
      subresources: { status: {} },
      additionalPrinterColumns: columns + [
        { name: 'Phase', type: 'string', jsonPath: '.status.phase' },
        { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' },
      ],
      schema: {
        openAPIV3Schema: {
          type: 'object',
          required: ['spec'],
          properties: {
            spec: spec { type: 'object' },
            status: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
          },
        },
      },
    }],
  },
};

{
  hostSets: crd(
    'AgentHostSet',
    {
      description: 'A StatefulSet whose pods are VS Code agent hosts (`code agent host`), and how the operator reaches them over AHP.',
      required: ['statefulSet', 'connectionToken'],
      properties: {
        statefulSet: string('The StatefulSet whose pods are this set’s hosts.'),
        container: string('The container the host runs in, for exec (clones). Default: the pod’s first container.'),
        port: { type: 'integer', minimum: 1, maximum: 65535, default: 8081, description: 'The host’s WebSocket port (`code agent host --port`).' },
        connectionToken: {
          type: 'object',
          description: 'The Secret the pods mount as --connection-token-file. The operator reads the same one.',
          required: ['secretName'],
          properties: {
            secretName: string(),
            key: string('Default token.') { default: 'token' },
          },
        },
        address: string('How clients reach each host, reported in status for them to copy, such as wss://{pod}.example-tailnet.ts.net. {pod} is the pod’s name.'),
      },
    },
    [{ name: 'StatefulSet', type: 'string', jsonPath: '.spec.statefulSet' }],
  ),

  workspaces: crd(
    'AgentWorkspace',
    {
      description: 'A git checkout on every host of the AgentHostSets it selects, for sessions and automations to work in.',
      required: ['repository'],
      properties: {
        repository: string('Clone URL. Cloned once, as the pod’s user with the pod’s git credentials; a changed URL is not cloned again over a checkout.'),
        ref: string('The branch to check out. Default: the remote’s default branch.'),
        path: string('The folder in the pod. Default /workspace/<name>.') { pattern: '^/' },
        hostSetSelector: labelSelector('AgentHostSets to place the workspace on, on every one of their hosts. Default {}: all of them.') { default: {} },
        deletionPolicy: enum(
          ['Retain', 'Delete'],
          default='Retain',
          description='When the workspace is deleted, or leaves a host: Retain leaves the folder; Delete removes it (resourceDelete over AHP).',
        ),
      },
    },
    [{ name: 'Repository', type: 'string', jsonPath: '.spec.repository' }],
  ),

  automations: crd(
    'AgentAutomation',
    {
      description: 'A prompt the host runs on a schedule, in a workspace: an automation in the host’s own catalogue (ahp-automations://). The host runs it; the operator decides which hosts hold it.',
      required: ['workspace', 'prompt', 'agent'],
      properties: {
        workspace: string('An AgentWorkspace: the working directory of each run, and the hosts it may go to (those holding the workspace).'),
        prompt: string('The message each run starts with.'),
        title: string('Default <name>.'),
        enabled: { type: 'boolean', default: true, description: 'Whether the schedule starts runs.' },
        trigger: {
          type: 'object',
          description: 'Without a schedule the automation runs only when started by hand.',
          properties: {
            schedule: string('Five cron fields, as AHP defines them, such as "0 3 * * 1-5". No seconds, years or macros.'),
            timeZone: string('IANA time zone the schedule is read in. Default UTC.') { default: 'UTC' },
            misfirePolicy: enum(['skip', 'runOnce'], description='Occurrences missed while the host was down: skip them, or run once. The host’s default is runOnce.'),
          },
        },
        agent: {
          type: 'object',
          required: ['provider'],
          properties: {
            provider: string('The agent, as the host names it (claude, codex, copilotcli; see the AgentHostSet’s status). Required: a host defers every run of an automation without one.'),
            model: string('A model id the provider offers.'),
            modelConfig: { type: 'object', description: 'Model-specific values.', 'x-kubernetes-preserve-unknown-fields': true },
          },
        },
        config: opaque('Session configuration values, such as its permission mode, passed to the host as they are.'),
        placement: enum(
          ['One', 'EachHost'],
          default='One',
          description='One: a single host holds the automation (the lowest ordinal holding the workspace), and keeps it across pod restarts. EachHost: every one does, so it runs once per host.',
        ),
      },
    },
    [
      { name: 'Workspace', type: 'string', jsonPath: '.spec.workspace' },
      { name: 'Schedule', type: 'string', jsonPath: '.spec.trigger.schedule' },
    ],
  ),
}

// The agent host operator's install manifests, as a jsonnet library: the
// source of deploy/install.yaml (`npm run render`), and what a Tanka setup
// vendors at a release tag (jsonnet-bundler, this directory).
//
//   local operator = import 'vscode-agent-host-operator/main.libsonnet';
//   local cfg = operator.config { namespace: 'agents' };
//   operator.crds + operator.objects(cfg)
//
// `crds` are cluster-scoped: apply them before anything that uses their
// kinds. `objects(cfg)` are namespaced, all in cfg.namespace, and hold no
// Secret: the connection tokens are the caller's, next to the StatefulSets.
local crds = import 'crds.libsonnet';
local version = (import 'version.json').version;

{
  // The operator's release. The default image is the one built from it.
  version: version,

  config: {
    // Required: where the operator runs, and the agent host pods it manages.
    namespace: null,
    name: 'agent-host-operator',
    labels: { app: $.config.name },
    image: 'ghcr.io/derfred/vscode-agent-host-operator:' + version,
    imagePullPolicy: 'IfNotPresent',

    // The connection-token Secrets the AgentHostSets name, the only Secrets
    // the operator may read. Empty: any Secret in the namespace (simplest;
    // list them here to narrow it).
    tokenSecrets: [],

    // A pass on every watched change; these timers cover what no watch
    // sees, inside the hosts. See README.md, "When".
    resyncIntervalSeconds: 300,
    cloningPollSeconds: 5,

    resources: {
      requests: { cpu: '10m', memory: '64Mi' },
      limits: { memory: '256Mi' },
    },
  },

  crds: [crds.hostSets, crds.workspaces, crds.automations],

  // What the operator does in its namespace: its own kinds, the
  // StatefulSets they name, their pods, the pods' content-ready condition,
  // git clone in the pods (pods/exec), and the connection-token Secrets.
  rules(cfg):: [
    {
      apiGroups: ['agenthost.derfred.com'],
      resources: ['agenthostsets', 'agentworkspaces', 'agentautomations'],
      verbs: ['get', 'list', 'watch', 'patch', 'update'],
    },
    {
      apiGroups: ['agenthost.derfred.com'],
      resources: ['agenthostsets/status', 'agentworkspaces/status', 'agentautomations/status'],
      verbs: ['get', 'patch', 'update'],
    },
    { apiGroups: ['apps'], resources: ['statefulsets'], verbs: ['get'] },
    { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: [''], resources: ['pods/status'], verbs: ['patch'] },
    // Clones run as `git clone` in the host's container. create for the
    // WebSocket exec of Kubernetes 1.31 and later, get before.
    { apiGroups: [''], resources: ['pods/exec'], verbs: ['create', 'get'] },
    { apiGroups: [''], resources: ['secrets'], verbs: ['get'] }
    + (if std.length(cfg.tokenSecrets) > 0 then { resourceNames: cfg.tokenSecrets } else {}),
  ],

  objects(cfg):: (
    assert cfg.namespace != null : 'vscode-agent-host-operator: config.namespace is required';
    local metadata = { name: cfg.name, namespace: cfg.namespace, labels: cfg.labels };
    [
      {
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: metadata,
      },
      {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'Role',
        metadata: metadata,
        rules: $.rules(cfg),
      },
      {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'RoleBinding',
        metadata: metadata,
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: cfg.name },
        subjects: [{ kind: 'ServiceAccount', name: cfg.name, namespace: cfg.namespace }],
      },
      {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: metadata,
        spec: {
          replicas: 1,
          // Never two reconcilers at once, even during a rollout.
          strategy: { type: 'Recreate' },
          selector: { matchLabels: cfg.labels },
          template: {
            metadata: { labels: cfg.labels },
            spec: {
              serviceAccountName: cfg.name,
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 1000,
                runAsGroup: 1000,
                fsGroup: 1000,
                seccompProfile: { type: 'RuntimeDefault' },
              },
              containers: [{
                name: 'operator',
                image: cfg.image,
                imagePullPolicy: cfg.imagePullPolicy,
                env: [
                  { name: 'NAMESPACE', valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } } },
                  { name: 'RESYNC_INTERVAL_SECONDS', value: std.toString(cfg.resyncIntervalSeconds) },
                  { name: 'CLONING_POLL_SECONDS', value: std.toString(cfg.cloningPollSeconds) },
                ],
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ['ALL'] },
                },
                resources: cfg.resources,
              }],
            },
          },
        },
      },
    ]
  ),
}

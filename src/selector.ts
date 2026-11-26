// Kubernetes LabelSelector matching (metav1.LabelSelector): matchLabels plus
// matchExpressions, all ANDed. An empty selector matches everything, as with
// a NetworkPolicy's podSelector: {}.

export interface LabelSelectorRequirement {
  readonly key: string;
  readonly operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist';
  readonly values?: ReadonlyArray<string>;
}

export interface LabelSelector {
  readonly matchLabels?: Readonly<Record<string, string>>;
  readonly matchExpressions?: ReadonlyArray<LabelSelectorRequirement>;
}

export function matches(selector: LabelSelector | undefined, labels: Readonly<Record<string, string>> = {}): boolean {
  const s = selector ?? {};
  for (const [key, value] of Object.entries(s.matchLabels ?? {})) {
    if (labels[key] !== value) return false;
  }
  for (const { key, operator, values = [] } of s.matchExpressions ?? []) {
    const has = Object.hasOwn(labels, key);
    const ok =
      operator === 'In'
        ? has && values.includes(labels[key]!)
        : operator === 'NotIn'
          ? !has || !values.includes(labels[key]!)
          : operator === 'Exists'
            ? has
            : !has;
    if (!ok) return false;
  }
  return true;
}

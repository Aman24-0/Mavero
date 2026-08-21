export const sandboxPolicies = ['required', 'optional', 'unrestricted'] as const;

export type SandboxPolicy = (typeof sandboxPolicies)[number];

export const defaultSandboxPolicy: SandboxPolicy = 'required';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isSandboxPolicy(value: unknown): value is SandboxPolicy {
  return typeof value === 'string' && sandboxPolicies.includes(value as SandboxPolicy);
}

export function sandboxPolicyFromCapabilities(...capabilities: unknown[]): SandboxPolicy {
  for (const capability of capabilities) {
    if (!isRecord(capability)) continue;
    const value = capability.sandbox_policy;
    if (isSandboxPolicy(value)) return value;
  }
  return defaultSandboxPolicy;
}

export function withSandboxPolicy(capabilities: Record<string, unknown>, policy: SandboxPolicy) {
  return { ...capabilities, sandbox_policy: policy };
}

export function iframeSandboxAttribute(policy: SandboxPolicy = defaultSandboxPolicy) {
  return policy === 'unrestricted' ? undefined : 'allow-forms allow-presentation allow-same-origin allow-scripts';
}

export function sandboxPolicyDescription(policy: SandboxPolicy) {
  if (policy === 'unrestricted') return 'Sandbox disabled for this embed. Use only when the provider explicitly requires it.';
  if (policy === 'optional') return 'Sandbox remains enabled by default; the provider may be reviewed for a different policy later.';
  return 'Sandbox remains enabled with MAVERO’s secure iframe permissions.';
}

/**
 * Sandbox policy — PROVIDER-LEVEL ONLY.
 *
 * Phase 8 sandbox simplification: the source-level sandbox configuration
 * has been REMOVED. Sandbox is now exclusively a provider-level setting
 * with two states: ON (required) and OFF (unrestricted).
 *
 * The previous architecture had 4 choices (required, optional,
 * unrestricted, provider_default) and a source > provider > system
 * inheritance hierarchy. This was unnecessarily complex and caused
 * data loss when admins changed sandbox without re-pasting the full
 * capabilities JSON.
 *
 * The new architecture:
 *   - Provider sets sandbox_policy: 'required' or 'unrestricted'.
 *   - Sources do NOT have sandbox_policy.
 *   - System default remains 'required'.
 *   - Legacy source sandbox_policy values are ignored/removed.
 *   - Legacy 'optional' policy is normalized to 'required'.
 */

export const sandboxPolicies = ['required', 'unrestricted'] as const;

export type SandboxPolicy = (typeof sandboxPolicies)[number];

export const defaultSandboxPolicy: SandboxPolicy = 'required';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isSandboxPolicy(value: unknown): value is SandboxPolicy {
  return typeof value === 'string' && sandboxPolicies.includes(value as SandboxPolicy);
}

/**
 * Returns the provider's sandbox policy, or the system default if
 * missing/invalid. Sources are no longer consulted — sandbox is
 * provider-level only.
 */
export function sandboxPolicyFromCapabilities(providerCapabilities: unknown, _sourceCapabilities?: unknown): SandboxPolicy {
  if (isRecord(providerCapabilities)) {
    const value = providerCapabilities.sandbox_policy;
    if (isSandboxPolicy(value)) return value;
    // Legacy 'optional' is normalized to 'required'.
    if (value === 'optional') return 'required';
  }
  return defaultSandboxPolicy;
}

/**
 * Merges a sandbox policy into a capabilities object, preserving
 * all existing keys. Used by the provider form to set sandbox_policy
 * without losing other capability fields.
 */
export function withSandboxPolicy<T extends Record<string, unknown>>(capabilities: T, policy: SandboxPolicy): T {
  return { ...capabilities, sandbox_policy: policy };
}

/**
 * Returns the iframe sandbox attribute string for a given policy.
 * - 'required' → secure sandbox attribute
 * - 'unrestricted' → undefined (no sandbox attribute)
 */
export function iframeSandboxAttribute(policy: SandboxPolicy = defaultSandboxPolicy): string | undefined {
  return policy === 'unrestricted' ? undefined : 'allow-forms allow-presentation allow-same-origin allow-scripts';
}

/**
 * Sandbox policy runtime — resolves the effective policy from the
 * provider capabilities only (sources no longer carry sandbox_policy).
 */
export type SandboxPolicyRuntime = {
  /** Always null — sources no longer have sandbox_policy. */
  configuredSandboxPolicy: SandboxPolicy | null;
  /** The provider-level policy. */
  providerSandboxPolicy: SandboxPolicy | null;
  /** The policy the runtime MUST apply (provider > system default). */
  effectiveSandboxPolicy: SandboxPolicy;
};

export function resolveSandboxRuntime(providerCapabilities: unknown, _sourceCapabilities?: unknown): SandboxPolicyRuntime {
  const providerPolicy = isRecord(providerCapabilities) && isSandboxPolicy(providerCapabilities.sandbox_policy)
    ? providerCapabilities.sandbox_policy as SandboxPolicy
    : (isRecord(providerCapabilities) && providerCapabilities.sandbox_policy === 'optional' ? 'required' : null);
  return {
    configuredSandboxPolicy: null,
    providerSandboxPolicy: providerPolicy,
    effectiveSandboxPolicy: providerPolicy ?? defaultSandboxPolicy,
  };
}

export function sandboxPolicyDescription(policy: SandboxPolicy): string {
  if (policy === 'unrestricted') return 'Sandbox disabled for this embed. Use only when the provider explicitly requires it.';
  return 'Sandbox enabled with MAVERO\'s secure iframe permissions.';
}

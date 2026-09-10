export const sandboxPolicies = ['required', 'optional', 'unrestricted'] as const;

export type SandboxPolicy = (typeof sandboxPolicies)[number];

export const defaultSandboxPolicy: SandboxPolicy = 'required';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isSandboxPolicy(value: unknown): value is SandboxPolicy {
  return typeof value === 'string' && sandboxPolicies.includes(value as SandboxPolicy);
}

/**
 * Resolves the effective policy from provider capabilities first, then source
 * capabilities. Provider policy is authoritative when explicitly configured;
 * missing or malformed values fall back to the secure default.
 */
export function sandboxPolicyFromCapabilities(providerCapabilities: unknown, sourceCapabilities?: unknown): SandboxPolicy {
  for (const capability of [providerCapabilities, sourceCapabilities]) {
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

/**
 * Whether the in-player sandbox control may turn the sandbox OFF for an
 * embed whose admin-configured policy is `policy`.
 *
 * The player control may only HARDEN a configuration, never WEAKEN it:
 * for `required`/`optional` embeds (the secure attribute is applied) the
 * sandbox stays enforced for the whole playback session, because a runtime
 * disable is exactly the route that lets provider popunders
 * (`window.open` / `target="_blank"`) open external browser tabs during
 * playback — the sandbox omits `allow-popups` and `allow-top-navigation*`,
 * and those browser guarantees only exist while the attribute is present
 * (see docs/peachify-redirect-investigation.md). Only an explicitly
 * `unrestricted` admin policy leaves the control available; toggling then
 * stays within the admin's own baseline (off by default, user may enable).
 *
 * An unknown/legacy `undefined` policy is treated as `required` (the
 * resolver's secure default), so it is locked too.
 */
export function playerCanDisableSandbox(policy: SandboxPolicy | undefined): boolean {
  return policy === 'unrestricted';
}

export function sandboxPolicyDescription(policy: SandboxPolicy) {
  if (policy === 'unrestricted') return 'Sandbox disabled for this embed. Use only when the provider explicitly requires it.';
  if (policy === 'optional') return 'Sandbox remains enabled by default; the provider may be reviewed for a different policy later.';
  return 'Sandbox remains enabled with MAVERO’s secure iframe permissions.';
}

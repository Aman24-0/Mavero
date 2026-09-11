export const sandboxPolicies = ['required', 'optional', 'unrestricted'] as const;

export type SandboxPolicy = (typeof sandboxPolicies)[number];

/**
 * Phase 10 (GOAL 20): the SOURCE-level configuration choices. A source may
 * explicitly store one of the three concrete policies, or it may explicitly
 * INHERIT the provider's policy — modeled by the sentinel value
 * `provider_default`, which is a CONFIGURATION choice, never a stored
 * policy: parsing a source form with `provider_default` removes any
 * `sandbox_policy` key from the source capabilities JSON so the hierarchy
 * below resolves through the provider.
 */
export const sandboxPolicyChoices = ['provider_default', ...sandboxPolicies] as const;

export type SandboxPolicyChoice = (typeof sandboxPolicyChoices)[number];

export const defaultSandboxPolicy: SandboxPolicy = 'required';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isSandboxPolicy(value: unknown): value is SandboxPolicy {
  return typeof value === 'string' && sandboxPolicies.includes(value as SandboxPolicy);
}

/** True when the value is one of the source-form choices (incl. inherit). */
export function isSandboxPolicyChoice(value: unknown): value is SandboxPolicyChoice {
  return typeof value === 'string' && sandboxPolicyChoices.includes(value as SandboxPolicyChoice);
}

/**
 * The EXPLICITLY CONFIGURED source policy, or `null` when the source does
 * not carry one (inherit). This is the CONFIGURED value (GOAL 20) — never
 * conflated with the EFFECTIVE policy below. Malformed values read as
 * inherit (fall-through), matching the historical behavior for garbage.
 */
export function configuredSandboxPolicy(sourceCapabilities: unknown): SandboxPolicy | null {
  if (!isRecord(sourceCapabilities)) return null;
  const value = sourceCapabilities.sandbox_policy;
  return isSandboxPolicy(value) ? value : null;
}

/**
 * Resolves the EFFECTIVE policy with the standard capability hierarchy:
 * source override → provider default → system default.
 *
 * A source-level value overrides the provider default when explicitly
 * configured; missing or malformed values fall through, and the secure
 * system default applies when neither level sets the key. The sandbox
 * policy is a fully independent playback setting and never interacts with
 * any other capability.
 */
export function sandboxPolicyFromCapabilities(providerCapabilities: unknown, sourceCapabilities?: unknown): SandboxPolicy {
  for (const capability of [sourceCapabilities, providerCapabilities]) {
    if (!isRecord(capability)) continue;
    const value = capability.sandbox_policy;
    if (isSandboxPolicy(value)) return value;
  }
  return defaultSandboxPolicy;
}

export function withSandboxPolicy(capabilities: Record<string, unknown>, policy: SandboxPolicy) {
  return { ...capabilities, sandbox_policy: policy };
}

/**
 * Phase 10 (GOAL 20): a source's capabilities for the `provider_default`
 * choice — the key is REMOVED so the source inherits the provider. Passing
 * an explicit policy stores it exactly as before. Generic over the input
 * record so a `JsonObject` stays a `JsonObject` (JSON-assignable).
 */
export function withSourceSandboxChoice<T extends Record<string, unknown>>(capabilities: T, choice: SandboxPolicyChoice): T {
  if (choice === 'provider_default') {
    const next = { ...capabilities };
    delete (next as Record<string, unknown>).sandbox_policy;
    return next;
  }
  return withSandboxPolicy(capabilities, choice) as unknown as T;
}

export function iframeSandboxAttribute(policy: SandboxPolicy = defaultSandboxPolicy) {
  return policy === 'unrestricted' ? undefined : 'allow-forms allow-presentation allow-same-origin allow-scripts';
}

/**
 * Phase 11 (GOAL D): the FULL sandbox resolution provenance for one embed
 * source — what the admin CONFIGURED at each level versus what the runtime
 * must actually apply. The playback runtime consumes
 * `effectiveSandboxPolicy`; `configured`/`provider` exist so admin-facing
 * surfaces (and tests) can never conflate a stored override with the
 * applied policy again.
 */
export type SandboxPolicyRuntime = {
  /** The source-level EXPLICIT policy, or `null` when the source inherits. */
  configuredSandboxPolicy: SandboxPolicy | null;
  /** The provider-level policy (the inheritance target of `null`). */
  providerSandboxPolicy: SandboxPolicy | null;
  /** The policy the runtime MUST apply (source > provider > system default). */
  effectiveSandboxPolicy: SandboxPolicy;
};

/**
 * Phase 11 (GOAL D): resolves the complete configured-vs-effective runtime
 * picture from the two capability records. Pure — the server embeds this on
 * every resolved embed PlayerSource so the client never has to guess, and
 * `effectiveSandboxPolicy` is ALWAYS the value `sandboxPolicyFromCapabilities`
 * computes (single source of truth for the hierarchy).
 */
export function resolveSandboxRuntime(providerCapabilities: unknown, sourceCapabilities?: unknown): SandboxPolicyRuntime {
  return {
    configuredSandboxPolicy: configuredSandboxPolicy(sourceCapabilities),
    providerSandboxPolicy: configuredSandboxPolicy(providerCapabilities),
    effectiveSandboxPolicy: sandboxPolicyFromCapabilities(providerCapabilities, sourceCapabilities),
  };
}

export function sandboxPolicyDescription(policy: SandboxPolicy) {
  if (policy === 'unrestricted') return 'Sandbox disabled for this embed. Use only when the provider explicitly requires it.';
  if (policy === 'optional') return 'Sandbox remains enabled by default; the provider may be reviewed for a different policy later.';
  return 'Sandbox remains enabled with MAVERO’s secure iframe permissions.';
}

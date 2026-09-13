import { Agent, fetch as undiciFetch } from 'undici';
import { isBlockedIpAddress, systemDnsResolver, type SafeDnsResolver } from './ssrf';

/**
 * MAVERO Stremio addon pipeline — connect-time destination guard (Phase 8).
 *
 * Closes the DNS-rebinding TOCTOU documented in `ssrf.ts` since Phase 2: the
 * pre-flight resolver (`assertSafeManifestDestination`) validates the DNS
 * answers, but Node's global fetch then performs its OWN resolution before
 * connecting, so a rebinding attacker could return a public IP to the
 * pre-flight check and a private/metadata IP to the actual connect.
 *
 * This module pins the validated address set to the socket itself:
 *
 *   * `createConnectTimeLookup` builds a Node-compatible `lookup` function
 *     that resolves the hostname, validates EVERY returned address with the
 *     SAME Phase 2 range rules (`isBlockedIpAddress`), and — if any address
 *     is blocked — fails the connection with an error callback BEFORE any
 *     socket exists. The connector only ever sees validated addresses.
 *   * `ssrfSafeAgent` is an undici `Agent` wired to that lookup. Because the
 *     connector hands the socket exactly the addresses this lookup returned,
 *     there is exactly ONE authoritative resolution per new connection, and
 *     it is fully validated (reused pooled sockets connect to an already
 *     validated address, so pooling introduces no new resolution).
 *   * `ssrfSafeFetch` is a drop-in default `fetcher` for the Phase 2/3
 *     fetchers (`manifest-fetch.ts` / `stream-fetch.ts`): identical call
 *     shape, `redirect: 'manual'` semantics, abort-signal support, but
 *     dispatched through `ssrfSafeAgent` via the SAME undici major that
 *     provides the Agent (npm `undici` fetch honors `init.dispatcher`;
 *     Node's global fetch does not reliably honor a foreign dispatcher).
 *
 * This is NOT a proxy and performs no I/O of its own: it only guards the
 * connections that the existing secure fetchers choose to make. The
 * pre-flight guard (`assertSafeManifestUrl` / `assertSafeManifestDestination`)
 * still runs first for every request and every redirect hop — it produces the
 * typed BLOCKED_URL/INVALID_URL errors and nice failure modes; this module is
 * the second, connect-time gate behind it.
 *
 * Server-only: lives in `$lib/server/streaming/stremio/` and is never
 * imported by client code (SvelteKit blocks `$lib/server` from the client).
 */

/** Options object Node passes to a net/tls `lookup` function. */
export type ConnectLookupOptions = {
  family?: number | string;
  hints?: number;
  all?: boolean;
};

/** Callback contract of a net/tls `lookup` function (both answer shapes). */
export type ConnectLookupCallback = (
  err: Error | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

/** Node-compatible `lookup` function shape (net.connect / tls.connect). */
export type ConnectLookupFunction = (
  hostname: string,
  options: ConnectLookupOptions,
  callback: ConnectLookupCallback,
) => void;

/** Injectable address validator so tests can exercise both gate outcomes. */
export type ConnectAddressValidator = (address: string) => boolean;

const CONNECT_LOOKUP_BLOCKED_MESSAGE = 'The manifest host resolves to a network location that is not allowed.';
const CONNECT_LOOKUP_EMPTY_MESSAGE = 'The manifest host could not be resolved.';

/**
 * Builds the connect-time validating lookup. Resolution defaults to the SAME
 * system resolver the pre-flight guard uses (`dns.lookup` all + verbatim), so
 * ordering is preserved and every answer is validated.
 *
 * Contract (verified against undici 8.10.2, see scripts/ phase 8 probe):
 *   * the connector TRUSTS the addresses a lookup hands back, so validation
 *     MUST live inside the lookup — a blocked answer fails the whole lookup
 *     with an error callback, never a filtered list;
 *   * `options.all` selects the array answer shape (autoSelectFamily path);
 *     otherwise the single `(err, address, family)` shape is used;
 *   * a requested family with no matching validated answer fails closed.
 */
export function createConnectTimeLookup(
  resolver: SafeDnsResolver = systemDnsResolver,
  isBlockedAddress: ConnectAddressValidator = isBlockedIpAddress,
): ConnectLookupFunction {
  return (hostname, options, callback) => {
    // At most one callback invocation, whether resolution fails, validation
    // fails, or the answer is delivered — and resolver rejections are always
    // routed into the callback (never left as unhandled rejections).
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      // net/tls short-circuit on a non-null err and never read the address;
      // the inert '' satisfies the LookupFunction callback arity.
      callback(error, '');
    };
    const succeed = (deliver: () => void) => {
      if (settled) return;
      settled = true;
      deliver();
    };

    let pending: Promise<ReadonlyArray<{ address: string; family: number }>>;
    try {
      pending = Promise.resolve(resolver(hostname));
    } catch (error) {
      // Resolver threw synchronously (fake resolvers in tests may do this).
      fail(new Error(CONNECT_LOOKUP_EMPTY_MESSAGE, { cause: error }));
      return;
    }
    pending
      .then((entries) => {
        if (!entries.length) {
          fail(new Error(CONNECT_LOOKUP_EMPTY_MESSAGE));
          return;
        }
        for (const entry of entries) {
          if (isBlockedAddress(entry.address)) {
            fail(new Error(CONNECT_LOOKUP_BLOCKED_MESSAGE));
            return;
          }
        }
        const requestedFamily = typeof options.family === 'number' ? options.family : Number.parseInt(String(options.family ?? '0'), 10);
        const usable =
          requestedFamily === 4 || requestedFamily === 6
            ? entries.filter((entry) => entry.family === requestedFamily)
            : entries;
        if (!usable.length) {
          fail(new Error(CONNECT_LOOKUP_EMPTY_MESSAGE));
          return;
        }
        if (options.all) {
          succeed(() => callback(null, usable.map((entry) => ({ address: entry.address, family: entry.family }))));
          return;
        }
        const first = usable[0];
        succeed(() => callback(null, first.address, first.family));
      })
      .catch((error: unknown) => {
        fail(new Error(CONNECT_LOOKUP_EMPTY_MESSAGE, { cause: error }));
      });
  };
}

/**
 * Module-level SSRF-safe dispatcher. undici pools connections per origin; a
 * pooled socket was created through the validating lookup, so reuse connects
 * only to an already-validated address. No request leaves this process
 * without either the pre-flight guard (typed errors) or this connect-time
 * guard (error callback) having validated the destination.
 */
export const ssrfSafeAgent = new Agent({
  connect: { lookup: createConnectTimeLookup(systemDnsResolver, isBlockedIpAddress) },
});

/**
 * Drop-in default fetcher for the addon pipeline fetchers. Same observable
 * contract as global `fetch` for the exact call shapes used by
 * `manifest-fetch.ts` / `stream-fetch.ts` (string URLs, `redirect: 'manual'`,
 * `signal`, plain headers) but dispatched through `ssrfSafeAgent`.
 *
 * Must be undici's OWN fetch (not the global): the npm dispatcher contract
 * is only guaranteed to pair with the fetch exported by the same package.
 */
export async function ssrfSafeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // The addon pipeline only ever passes string URLs. undici's RequestInit is
  // a superset of the global one with the `dispatcher` vendor extension; the
  // cast is the single vendor boundary in this module.
  const response = await undiciFetch(input as string | URL, { ...(init ?? {}), dispatcher: ssrfSafeAgent } as unknown as Parameters<typeof undiciFetch>[1]);
  return response as unknown as Response;
}

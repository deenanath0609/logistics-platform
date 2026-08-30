/**
 * One derivation of the calling address, for the whole application.
 *
 * `X-Forwarded-For` is a header. Anyone can send one, and a client that
 * sends `X-Forwarded-For: 1.2.3.4` is simply asserting that it is 1.2.3.4.
 * The only part of the chain a deployment may believe is the part its own
 * proxies wrote, and the only way to know where that part starts is to be
 * told how many proxies there are — hence `TRUSTED_PROXY_HOPS`.
 *
 * The chain grows left to right: each hop appends the address it saw. So
 * the *last* entry was written by the proxy nearest to us and names the hop
 * in front of it; behind a single load balancer that entry is the client.
 * Behind two it is the outer balancer, and the client is one further left.
 * Taking `chain[chain.length - hops]` states that relationship directly.
 *
 * ── Why every result carries `trusted` ───────────────────────
 * With `TRUSTED_PROXY_HOPS=0` there is no honest answer available. Next's
 * own server fills the header in from the socket when the client sent none
 * (`req.headers['x-forwarded-for'] ??= socket.remoteAddress` in
 * base-server), but `??=` means a client that *does* send one keeps it, and
 * nothing downstream can tell the two apart. A route handler has no access
 * to the socket, so the address cannot be recovered another way.
 *
 * Rather than pretend, the derivation reports both the best value it has
 * and whether that value came from a configured hop. Callers then decide
 * honestly:
 *
 *  - Rate limiting buckets on the value even when untrusted. A forgeable
 *    bucket key is weaker than a real one, but it is far better than one
 *    global bucket in which every anonymous caller throttles every other.
 *  - The API key IP allowlist and the audit trail require `trusted`. An
 *    allowlist satisfied by a self-declared address is decoration, and an
 *    audit row naming an address the actor chose is worse than one naming
 *    no address at all.
 * ─────────────────────────────────────────────────────────────
 */

export type ClientIp = {
  /**
   * Best available address, or null when no header offered one. Safe to
   * bucket on; never safe to authorise or record on unless `trusted`.
   */
  value: string | null;
  /** True only when `value` was written by a configured trusted proxy. */
  trusted: boolean;
};

const UNTRUSTED_NONE: ClientIp = { value: null, trusted: false };

/** Reads the chain a hop at a time, dropping the empty entries proxies leave. */
function chainOf(forwardedFor: string | null | undefined): string[] {
  if (!forwardedFor) return [];
  return forwardedFor
    .split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop !== "");
}

/**
 * Derives the calling address from forwarding headers and a hop count.
 *
 * Pure, so the cases that matter — no proxy, one proxy, two proxies, a
 * chain shorter than configured, a chain padded by the client — are
 * ordinary unit tests rather than a live request behind a real balancer.
 */
export function deriveClientIp(input: {
  forwardedFor: string | null | undefined;
  realIp?: string | null;
  /** Number of reverse proxies between the internet and this process. */
  hops: number;
}): ClientIp {
  const chain = chainOf(input.forwardedFor);
  const realIp = input.realIp?.trim() || null;
  const hops = Number.isInteger(input.hops) && input.hops > 0 ? input.hops : 0;

  if (hops === 0) {
    // No proxy configured, so nothing in the chain was written by us. The
    // rightmost entry is what Next defaulted from the socket on a direct
    // connection, which makes it the most useful value on offer — and it
    // is offered as untrusted, because a client that sent its own header
    // produced exactly the same shape.
    return { value: chain[chain.length - 1] ?? realIp, trusted: false };
  }

  if (chain.length < hops) {
    // Fewer hops than the deployment says exist. Either the configuration
    // is wrong or the request reached this process without passing through
    // the proxies — bypassing an internal load balancer is precisely the
    // move an attacker inside the network would make. Usable for
    // throttling, never for authorisation.
    return { value: chain[chain.length - 1] ?? realIp, trusted: false };
  }

  const value = chain[chain.length - hops];
  return value ? { value, trusted: true } : UNTRUSTED_NONE;
}

/**
 * The same derivation, reading the headers of a live request.
 *
 * `x-real-ip` is consulted only as a fallback when there is no chain at
 * all: it carries no hop information, so it can never be the trusted
 * answer — a proxy that sets it also sets `X-Forwarded-For`.
 */
export function clientIpFrom(headers: Headers, hops: number): ClientIp {
  return deriveClientIp({
    forwardedFor: headers.get("x-forwarded-for"),
    realIp: headers.get("x-real-ip"),
    hops,
  });
}

/**
 * A rate-limiting bucket key for a caller.
 *
 * Trust is folded into the key so a forged address can never share, and so
 * never exhaust, the bucket of a genuine one. `unknown` is the shared
 * bucket of last resort — deliberately a real bucket rather than a bypass,
 * because "we could not identify the caller" must not mean "no limit".
 */
export function ipBucketKey(prefix: string, ip: ClientIp): string {
  return `${prefix}:${ip.trusted ? "t" : "u"}:${ip.value ?? "unknown"}`;
}

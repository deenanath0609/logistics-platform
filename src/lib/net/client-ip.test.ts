import { describe, expect, it } from "vitest";
import { clientIpFrom, deriveClientIp, ipBucketKey } from "./client-ip";

/**
 * The header a caller writes, and the address a deployment may believe.
 *
 * Every case below existed as a live bug: the six call sites all took the
 * *leftmost* `X-Forwarded-For` value, which is the one entry in the chain
 * that nothing verified. `203.0.113.7` in these tests stands for a real
 * client, `198.51.100.x` for the deployment's own proxies, and
 * `10.9.9.9` for whatever an attacker chose to type.
 */

describe("deriveClientIp — no proxy configured", () => {
  it("trusts nothing, because nothing in the chain was written by us", () => {
    const ip = deriveClientIp({ forwardedFor: "10.9.9.9", hops: 0 });
    expect(ip.trusted).toBe(false);
  });

  it("still offers the rightmost hop, which is what Next set from the socket", () => {
    // Next's server does `x-forwarded-for ??= socket.remoteAddress`, so on a
    // direct connection from a client that sent no header, the single entry
    // is the socket address — useful for bucketing, never for authorising.
    const ip = deriveClientIp({ forwardedFor: "203.0.113.7", hops: 0 });
    expect(ip.value).toBe("203.0.113.7");
    expect(ip.trusted).toBe(false);
  });

  it("does not hand back the leftmost value a caller padded the chain with", () => {
    const ip = deriveClientIp({ forwardedFor: "10.9.9.9, 203.0.113.7", hops: 0 });
    expect(ip.value).not.toBe("10.9.9.9");
  });
});

describe("deriveClientIp — one proxy", () => {
  it("takes the last hop, not the first", () => {
    // The chain grows left to right, so the entry the load balancer wrote
    // is the last one, and it names the address the balancer actually saw.
    const ip = deriveClientIp({
      forwardedFor: "203.0.113.7",
      hops: 1,
    });
    expect(ip).toEqual({ value: "203.0.113.7", trusted: true });
  });

  it("ignores everything a caller prepended", () => {
    const ip = deriveClientIp({
      forwardedFor: "10.9.9.9, 192.0.2.50, 203.0.113.7",
      hops: 1,
    });
    expect(ip).toEqual({ value: "203.0.113.7", trusted: true });
  });
});

describe("deriveClientIp — two proxies", () => {
  it("steps back one further, past the inner balancer", () => {
    // client → outer CDN → inner LB → us. The inner LB wrote the last
    // entry (the CDN's address); the client is one to its left.
    const ip = deriveClientIp({
      forwardedFor: "203.0.113.7, 198.51.100.4",
      hops: 2,
    });
    expect(ip).toEqual({ value: "203.0.113.7", trusted: true });
  });

  it("refuses to trust a chain shorter than the configured hops", () => {
    // Fewer hops than the deployment says exist means the request did not
    // come through the proxies — which is what bypassing an internal load
    // balancer looks like from in here.
    const ip = deriveClientIp({ forwardedFor: "10.9.9.9", hops: 2 });
    expect(ip.trusted).toBe(false);
  });
});

describe("deriveClientIp — degenerate input", () => {
  it("tolerates the whitespace and empty entries proxies leave behind", () => {
    const ip = deriveClientIp({
      forwardedFor: " 10.9.9.9 ,, 203.0.113.7 ,",
      hops: 1,
    });
    expect(ip).toEqual({ value: "203.0.113.7", trusted: true });
  });

  it("falls back to X-Real-IP only when there is no chain, and never trusts it", () => {
    // A proxy that sets X-Real-IP sets X-Forwarded-For too, so this value
    // carries no hop information and cannot be positioned in a chain.
    const ip = deriveClientIp({
      forwardedFor: null,
      realIp: "203.0.113.7",
      hops: 1,
    });
    expect(ip).toEqual({ value: "203.0.113.7", trusted: false });
  });

  it("answers null when no header offered anything", () => {
    expect(deriveClientIp({ forwardedFor: null, hops: 1 })).toEqual({
      value: null,
      trusted: false,
    });
  });

  it("treats a negative or fractional hop count as no proxy", () => {
    expect(deriveClientIp({ forwardedFor: "10.9.9.9", hops: -1 }).trusted).toBe(false);
    expect(deriveClientIp({ forwardedFor: "10.9.9.9", hops: 1.5 }).trusted).toBe(false);
  });
});

describe("clientIpFrom", () => {
  it("reads the same derivation off a live request's headers", () => {
    const headers = new Headers({
      "x-forwarded-for": "10.9.9.9, 203.0.113.7",
      "x-real-ip": "198.51.100.4",
    });
    expect(clientIpFrom(headers, 1)).toEqual({
      value: "203.0.113.7",
      trusted: true,
    });
  });
});

describe("ipBucketKey", () => {
  it("keeps a forged address out of a genuine caller's bucket", () => {
    const forged = ipBucketKey("track", { value: "203.0.113.7", trusted: false });
    const real = ipBucketKey("track", { value: "203.0.113.7", trusted: true });
    expect(forged).not.toBe(real);
  });

  it("buckets an unidentifiable caller rather than exempting them", () => {
    expect(ipBucketKey("track", { value: null, trusted: false })).toBe(
      "track:u:unknown",
    );
  });
});

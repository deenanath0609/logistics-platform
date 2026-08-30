/**
 * The shape every operator service returns.
 *
 * The same discriminated union the complaint service uses. A refusal — a
 * taken subdomain, a plan still in use, a missing reason — is a value the
 * caller renders, not an exception it has to catch and stringify. Only
 * genuine faults throw.
 */
export type PlatformResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export function ok<T>(data: T): PlatformResult<T> {
  return { ok: true, data };
}

export function fail<T = never>(error: string): PlatformResult<T> {
  return { ok: false, error };
}

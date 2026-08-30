import http from "node:http";

/**
 * An HTTP request to a named virtual host on a local server.
 *
 * Neither obvious approach works here, and both fail quietly:
 *
 * - `fetch(url)` against `acme.localhost` fails outright. Resolving
 *   `*.localhost` to the loopback is a browser convention, not a DNS one,
 *   so Node has never heard of the name.
 * - `fetch(url, { headers: { host } })` looks like the answer and is worse.
 *   `host` is a forbidden header name in undici, dropped silently, so the
 *   request goes to whatever host was in the URL while the test believes it
 *   went somewhere else. That cost this project two rounds of chasing a
 *   phantom: a suite that reported the operator console 404ing on its own
 *   host, and then reported a carrier's host serving it. Neither happened.
 *
 * `node:http` lets the connection go to the loopback while the `Host`
 * header names the virtual host — which is exactly what a browser does, and
 * what the tenant resolver reads.
 */
export type HostResponse = {
  status: number;
  location: string | null;
  body: string;
  /** Every `Set-Cookie` verbatim, for callers that keep a jar. */
  setCookie: string[];
  headers: Record<string, string | string[] | undefined>;
};

export type HostRequestOptions = {
  cookie?: string;
  method?: string;
  /** A request body. Set `contentType` alongside it. */
  body?: string;
  contentType?: string;
  /** Anything else — `authorization`, `idempotency-key`, and so on. */
  headers?: Record<string, string>;
};

export function hostFetch(
  host: string,
  port: number,
  path: string,
  options: HostRequestOptions = {},
): Promise<HostResponse> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? null : Buffer.from(options.body, "utf8");

    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? (payload ? "POST" : "GET"),
        headers: {
          host: `${host}:${port}`,
          ...(options.cookie ? { cookie: options.cookie } : {}),
          ...(payload
            ? {
                "content-type": options.contentType ?? "application/x-www-form-urlencoded",
                "content-length": String(payload.length),
              }
            : {}),
          ...(options.headers ?? {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk as Buffer));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            location: (response.headers.location as string | undefined) ?? null,
            body: Buffer.concat(chunks).toString("utf8"),
            setCookie: response.headers["set-cookie"] ?? [],
            headers: response.headers,
          }),
        );
      },
    );

    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

/**
 * A cookie jar — one signed-in identity per instance.
 *
 * The sign-in flows these scripts drive are redirect chains that set a
 * cookie on one hop and expect it back on the next, so the jar and the
 * redirect follower below belong together: either alone lets a session
 * evaporate silently, which reads as "the guard works" rather than as the
 * bug it is.
 */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  absorb(response: HostResponse): void {
    for (const raw of response.setCookie) {
      const [pair] = raw.split(";");
      const index = pair.indexOf("=");
      if (index > 0) {
        this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      }
    }
  }
}

/**
 * `hostFetch` plus redirect following, carrying the jar through each hop.
 *
 * `node:http` does not follow redirects, and the sign-in callback answers
 * with one, so a script that does not spell this out never gets past the
 * login page.
 */
export async function hostFollow(
  host: string,
  port: number,
  path: string,
  jar: CookieJar,
  options: HostRequestOptions = {},
): Promise<HostResponse & { finalPath: string }> {
  let current = path;
  let request: HostRequestOptions = options;

  for (let hop = 0; hop < 8; hop += 1) {
    const response = await hostFetch(host, port, current, {
      ...request,
      cookie: jar.header(),
    });
    jar.absorb(response);

    const redirecting =
      response.location && response.status >= 300 && response.status < 400;
    if (!redirecting) return { ...response, finalPath: current };

    const location = response.location as string;
    current = location.startsWith("http")
      ? new URL(location).pathname + new URL(location).search
      : location;
    // A redirect is always followed as a GET; carrying the POST body on
    // would re-submit the form against whatever the guard sent us to.
    request = {};
  }

  throw new Error(`Too many redirects from ${path}`);
}

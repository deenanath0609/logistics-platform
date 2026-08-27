import { signOut } from "@/lib/auth";

/**
 * Sign out by visiting a URL.
 *
 * The user menu already has a sign-out button, but that is only reachable
 * once you are *successfully* signed in. This route is the way out when
 * you are not: a session cookie left over from a rotated `AUTH_SECRET`
 * cannot be decrypted, so the app treats you as anonymous while the
 * browser keeps sending the dead cookie on every request.
 *
 * Clearing it needs a server response — the cookie is HttpOnly, which is
 * exactly what stops a script from touching it.
 */
export async function GET() {
  await signOut({ redirectTo: "/login" });
}

#!/usr/bin/env bash
#
# A certificate for one carrier's subdomain.
#
#   sudo carrier-cert acme
#   sudo carrier-cert acme --dry-run
#
# Every carrier lives on its own host — `<carrier>.lms.credohrms.com` — and
# every one of those hosts needs TLS, because the session cookie is issued
# `Secure` in production and a browser will not send a Secure cookie back
# over plain HTTP. Without a certificate a carrier can sign in and then find
# themselves signed out on the very next click, which is a confusing way to
# discover a missing certificate.
#
# ── Why one certificate per carrier, and not a wildcard ─────
#
# A wildcard would cover every carrier at once and need nothing done per
# tenant — but Let's Encrypt only issues wildcards through a DNS-01
# challenge, which means an API credential for the DNS provider. GoDaddy
# gates its DNS API behind holding ten or more domains, so that door is
# closed here. HTTP-01 needs no credential at all: the certificate authority
# fetches a file over port 80, which is already open and already pointed at
# this server by the wildcard A record.
#
# The cost is this script: one run per carrier, at provisioning time. That is
# a fair trade for having no API key to store, rotate or leak — and if the
# DNS ever moves to a provider with an open API, a wildcard replaces all of
# this and the script can go.
#
# Safe to re-run. A subdomain already on the certificate is left alone.

set -euo pipefail

ROOT_DOMAIN="${ROOT_DOMAIN:-lms.credohrms.com}"
CONTACT="${CERT_CONTACT:-acad.amitgupta@gmail.com}"

if [ $# -lt 1 ]; then
  echo "usage: sudo carrier-cert <subdomain-label> [--dry-run]" >&2
  echo "   eg: sudo carrier-cert acme      →  acme.${ROOT_DOMAIN}" >&2
  exit 2
fi

LABEL="$1"
shift
EXTRA=("$@")

# A label, not a hostname. Passing the whole thing would quietly ask for a
# certificate for someone else's domain.
if [[ ! "${LABEL}" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]; then
  echo "\"${LABEL}\" is not a subdomain label. Pass the carrier's subdomain only — \"acme\", not \"acme.${ROOT_DOMAIN}\"." >&2
  exit 2
fi

HOST="${LABEL}.${ROOT_DOMAIN}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo — it writes to /etc/letsencrypt and reloads nginx." >&2
  exit 2
fi

# ── Does the name point here at all ─────────────────────────
#
# Checked before asking for a certificate rather than after: a name that does
# not resolve fails the HTTP-01 challenge with a message about validation,
# which reads like a certificate problem and is really a DNS problem. The
# wildcard record covers every carrier, so a failure here usually means the
# wildcard is missing rather than that this carrier is special.
RESOLVED="$(getent hosts "${HOST}" | awk '{print $1}' | head -1 || true)"
MINE="$(curl -s --max-time 10 https://api.ipify.org || true)"

if [ -z "${RESOLVED}" ]; then
  echo "${HOST} does not resolve." >&2
  echo "Add a wildcard A record for *.${ROOT_DOMAIN} pointing at this server, then re-run." >&2
  exit 1
fi

if [ -n "${MINE}" ] && [ "${RESOLVED}" != "${MINE}" ]; then
  echo "${HOST} resolves to ${RESOLVED}, but this server is ${MINE}." >&2
  echo "The challenge would be answered by whatever is at ${RESOLVED}, not by us." >&2
  exit 1
fi

# ── Already covered? ────────────────────────────────────────
if certbot certificates 2>/dev/null | grep -qE "^\s+Domains:.*\b${HOST//./\\.}\b"; then
  echo "${HOST} is already on a certificate. Nothing to do."
  exit 0
fi

# ── Every name already on the certificate, plus this one ────
#
# This list is gathered rather than assumed, and that is the whole of the
# danger in this script. `--expand` with `--cert-name` reissues the
# certificate for exactly the names it is given: pass only the root and the
# new carrier, and every carrier added before today silently drops off the
# certificate and starts serving a name it no longer covers. So the existing
# names are read back out of certbot and passed in again.
EXISTING="$(certbot certificates --cert-name "${ROOT_DOMAIN}" 2>/dev/null \
  | awk -F: '/^[[:space:]]+Domains:/ {print $2}' \
  | tr -s ' ' '\n' | grep -v '^$' || true)"

DOMAIN_ARGS=()
for name in ${EXISTING} "${ROOT_DOMAIN}" "${HOST}"; do
  # De-duplicate: the root is in the existing list already, and a repeated
  # -d is not an error but does make the log harder to read.
  case " ${DOMAIN_ARGS[*]-} " in
    *" -d ${name} "*) continue ;;
  esac
  DOMAIN_ARGS+=(-d "${name}")
done

echo "Requesting a certificate for ${HOST}…"
echo "  covering: $(printf '%s ' "${DOMAIN_ARGS[@]}" | sed 's/-d //g')"

# A rehearsal is a different subcommand, not a flag.
#
# `certbot --nginx` is the `run` subcommand, which obtains *and installs*, and
# certbot refuses `--dry-run` there — reasonably, since there is nothing to
# install from a staging certificate. So a rehearsal runs `certonly`, which
# proves the part that can actually fail: that the challenge is answered and
# the authority is willing. Nothing is written to nginx either way.
DRY=false
for arg in ${EXTRA[@]+"${EXTRA[@]}"}; do
  [ "${arg}" = "--dry-run" ] && DRY=true
done

if [ "${DRY}" = true ]; then
  certbot certonly --nginx \
    --cert-name "${ROOT_DOMAIN}" \
    "${DOMAIN_ARGS[@]}" \
    --expand \
    --non-interactive --agree-tos -m "${CONTACT}" \
    --dry-run
  echo
  echo "Rehearsal only — nothing was issued or installed."
  exit 0
fi

# One certificate and one renewal timer for the whole estate is easier to
# reason about than a drawer full of them, and Let's Encrypt allows a hundred
# names on a certificate — more carriers than this server will hold.
certbot --nginx \
  --cert-name "${ROOT_DOMAIN}" \
  "${DOMAIN_ARGS[@]}" \
  --expand \
  --non-interactive --agree-tos -m "${CONTACT}" \
  --redirect \
  ${EXTRA[@]+"${EXTRA[@]}"}

nginx -t
systemctl reload nginx

echo
echo "${HOST} is on HTTPS. Renewal is handled by the certbot timer already installed."

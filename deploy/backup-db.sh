#!/usr/bin/env bash
#
# A nightly backup that can actually be restored.
#
#   deploy/backup-db.sh [destination]        default /opt/backups
#
# ── Why this takes two files and not one ────────────────────────────────
#
# `pg_dump` does not dump roles. They are cluster-wide objects and live in
# `pg_dumpall --globals-only`. A restore from the table dump alone brings
# back every row and every row-level-security policy, and those policies
# then name a `logistics_app` role that does not exist on the new server.
# Postgres will not invent it. The application cannot connect.
#
# What happens next is the part worth writing down: the instinct at three in
# the morning is to point the application at the owner account instead, and
# the system comes straight back up looking healthy — with its tenant
# isolation switched off, because row-level security does not apply to a
# table's owner. One carrier would then read another's consignments and
# nothing would look wrong.
#
# So the globals are dumped beside the data, every night, and
# `scripts/restore-drill.mjs` rehearses the whole thing.
#
# ── Restoring ───────────────────────────────────────────────────────────
#
#   createdb -U postgres logistics_restored
#   psql -U postgres -f globals-YYYY-MM-DD.sql            # roles first
#   pg_restore -U postgres -d logistics_restored --no-owner \
#     --role=postgres logistics-YYYY-MM-DD.dump
#
# Roles first, always. The restore references them. The globals carry no
# passwords (see below), so set the application role's from `.env` after —
# or simply run `node scripts/apply-rls.mjs --apply`, which creates the role
# and its grants from the same source of truth the live server uses.

set -euo pipefail

DEST="${1:-/opt/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"

# The owner's URL, not the application's: the application role owns nothing
# and so can dump nothing. Read from the app's own env file so there is one
# place the credentials live.
ENV_FILE="${ENV_FILE:-/opt/logistics/.env}"
if [ ! -r "$ENV_FILE" ]; then
  echo "backup: cannot read $ENV_FILE" >&2
  exit 1
fi

# Only the line we need, and only its value — sourcing the whole file runs
# whatever else is in it, and it has already tripped over an unquoted value
# with a space in it.
OWNER_URL="$(sed -n 's/^MIGRATE_DATABASE_URL=//p' "$ENV_FILE" | tr -d '"' | head -1)"
if [ -z "$OWNER_URL" ]; then
  echo "backup: MIGRATE_DATABASE_URL is not set in $ENV_FILE" >&2
  exit 1
fi

mkdir -p "$DEST"

DATA="$DEST/logistics-$STAMP.dump"
GLOBALS="$DEST/globals-$STAMP.sql"

# `--format=custom` so a single table can be pulled back without replaying
# the whole file, which is what an accidental delete actually needs.
pg_dump --format=custom --no-owner --file="$DATA" "$OWNER_URL"

# `--no-role-passwords` because this connects as `logistics_owner`, which is
# not a superuser and so cannot read `pg_authid`. Without the flag pg_dumpall
# fails — and it fails *loudly to stderr while still exiting zero*, which is
# how the first run of this script wrote a 229-byte globals file, reported
# success, and left a backup that could not have been restored.
#
# It is also the better answer on its own terms: role passwords do not belong
# in a nightly file on disk. The application role's password lives in `.env`
# and `scripts/apply-rls.mjs --apply` recreates the role from it, which the
# restore procedure above already runs.
pg_dumpall --globals-only --no-role-passwords --file="$GLOBALS" --dbname="$OWNER_URL"

# A dump that cannot be listed is not a dump. This reads the archive's own
# table of contents, which catches a truncated write here rather than during
# a restore three weeks from now.
if ! pg_restore --list "$DATA" > /dev/null 2>&1; then
  echo "backup: $DATA is not a readable archive — removing it" >&2
  rm -f "$DATA" "$GLOBALS"
  exit 1
fi

# The globals half, checked the same way and for the same reason. A file
# that exists is not a dump: the failing run produced a well-formed header
# and no roles at all, which is exactly what a restore would not notice
# until the application could not connect.
if ! grep -q '^CREATE ROLE ' "$GLOBALS"; then
  echo "backup: $GLOBALS contains no roles — removing both" >&2
  rm -f "$DATA" "$GLOBALS"
  exit 1
fi

chmod 600 "$DATA" "$GLOBALS"

# Deleted only after the new pair is written and verified, so a failure
# tonight never costs last night's copy.
find "$DEST" -name 'logistics-*.dump' -mtime "+$KEEP_DAYS" -delete
find "$DEST" -name 'globals-*.sql' -mtime "+$KEEP_DAYS" -delete

SIZE="$(du -h "$DATA" | cut -f1)"
echo "backup: $DATA ($SIZE) and its globals, keeping $KEEP_DAYS days"

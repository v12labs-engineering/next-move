#!/bin/sh
set -eu

# Local replay uses complete filenames because two historical migrations share
# a numeric prefix. Each migration and its ledger entry commit together.
psql -X -v ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA IF NOT EXISTS local_deploy;
REVOKE ALL ON SCHEMA local_deploy FROM PUBLIC;
CREATE TABLE IF NOT EXISTS local_deploy.migrations (filename text PRIMARY KEY);
SQL

for path in /migrations/*.sql; do
  filename=${path##*/}
  case "$filename" in
    *[!a-zA-Z0-9_.-]*) echo "Invalid migration name: $filename" >&2; exit 1 ;;
  esac
  applied=$(psql -XAt -v ON_ERROR_STOP=1 -c "SELECT 1 FROM local_deploy.migrations WHERE filename = '$filename'")
  [ "$applied" = 1 ] && continue
  echo "Applying $filename"
  psql -X -v ON_ERROR_STOP=1 --single-transaction \
    -f "$path" -c "INSERT INTO local_deploy.migrations VALUES ('$filename')"
done

psql -X -v ON_ERROR_STOP=1 -f /local/ai-allowance.sql

#!/bin/sh
# Full NAS code releases only. Never enumerate or replace user data/config.
set -eu
umask 077

fail() { printf '%s\n' "$*" >&2; exit 1; }
ordinary_directory() {
  test -d "$1" && test ! -L "$1" || fail 'release directory is missing or linked'
  test "$(cd "$1" && pwd -P)" = "$1" || fail 'release path contains a link or noncanonical component'
}
ordinary_item() {
  test ! -L "$1" || fail 'release item is linked'
  if test -d "$1"; then
    test -z "$(find "$1" -type l -print)" || fail 'release tree contains links'
    test -z "$(find "$1" ! -type d ! -type f -print)" || fail 'release tree contains nonordinary files'
  else
    test -f "$1" || fail 'release item is not an ordinary file'
  fi
}
allowed_name() {
  case "$1" in
    src|public|package.json|package-lock.json|release.json|Dockerfile|.dockerignore|TRANSFER-MANIFEST.txt|compose.nas.yaml|compose.worker.yaml) ;;
    *) fail 'item outside release scope' ;;
  esac
}
matches() {
  if test -e "$2"; then
    test -e "$1" && diff -r "$1" "$2" >/dev/null 2>&1
  else
    test ! -e "$1" && test ! -L "$1"
  fi
}
fingerprint() (
  cd "$transaction"
  { find before after -type d -print; find before after -type f -exec sha256sum {} \;; sha256sum names root; } |
    LC_ALL=C sort | sha256sum | cut -d ' ' -f 1
)

test "$#" -ge 3 || fail 'usage: prepare root stage transaction replace-compose worker-transport | apply/rollback root transaction'
mode=$1
root=$2
case "$root" in /*) ;; *) fail 'release root must be absolute' ;; esac
test "$root" != / || fail 'release root cannot be a filesystem root'
ordinary_directory "$root"

if test "$mode" = prepare; then
  test "$#" = 6 || fail 'prepare requires stage, transaction and compose options'
  stage=$3
  transaction=$4
  replace_compose=$5
  worker_transport=$6
  case "$replace_compose:$worker_transport" in 0:0|0:1|1:0|1:1) ;; *) fail 'invalid compose options' ;; esac
  test "$(dirname "$stage")" = "$root/.staging" || fail 'stage outside project staging'
  case "$(basename "$stage")" in code-*) ;; *) fail 'invalid stage name' ;; esac
  ordinary_directory "$stage"
else
  test "$#" = 3 || fail 'apply/rollback requires one transaction'
  transaction=$3
fi
test "$(dirname "$transaction")" = "$root/backups" || fail 'transaction outside project backups'
case "$(basename "$transaction")" in code-*.tree) ;; *) fail 'invalid transaction name' ;; esac
ordinary_directory "$root/backups"
command -v sha256sum >/dev/null 2>&1 || fail 'sha256sum is required for code backup verification'

if test "$mode" = prepare; then
  test ! -e "$transaction" && test ! -L "$transaction" || fail 'transaction already exists'
  mkdir "$transaction"
  mkdir "$transaction/before" "$transaction/after" "$transaction/touched" "$transaction/retired" "$transaction/failed"
  cp "$0" "$transaction/recover.sh"
  printf '%s\n' src public package.json package-lock.json release.json Dockerfile .dockerignore TRANSFER-MANIFEST.txt > "$transaction/names"
  # Existing Compose files are user configuration unless explicitly replaced.
  if test "$replace_compose" = 1 || test ! -e "$root/compose.nas.yaml"; then
    printf '%s\n' compose.nas.yaml >> "$transaction/names"
  fi
  if test "$worker_transport" = 1 && { test "$replace_compose" = 1 || test ! -e "$root/compose.worker.yaml"; }; then
    printf '%s\n' compose.worker.yaml >> "$transaction/names"
  fi
  while IFS= read -r name; do
    allowed_name "$name"
    ordinary_item "$stage/$name"
    cp -a "$stage/$name" "$transaction/after/$name"
    if test -e "$root/$name" || test -L "$root/$name"; then
      ordinary_item "$root/$name"
      cp -a "$root/$name" "$transaction/before/$name"
    fi
  done < "$transaction/names"
  printf '%s\n' "$root" > "$transaction/root"
  fingerprint > "$transaction/payload.sha256"
  : > "$transaction/prepared"
  exit 0
fi

ordinary_directory "$transaction"
test -f "$transaction/prepared" && test "$(cat "$transaction/root")" = "$root" || fail 'transaction does not belong to this project'
ordinary_directory "$transaction/before"
ordinary_directory "$transaction/after"
ordinary_directory "$transaction/touched"
ordinary_directory "$transaction/retired"
ordinary_directory "$transaction/failed"
ordinary_item "$transaction/before"
ordinary_item "$transaction/after"
test "$(fingerprint)" = "$(cat "$transaction/payload.sha256")" || fail 'code backup integrity failure'

case "$mode" in
  apply)
    test ! -e "$transaction/applied" && test ! -e "$transaction/rolled-back" || fail 'transaction already used'
    test -z "$(ls -A "$transaction/touched")" || fail 'interrupted transaction needs rollback'
    # Check every input before replacing anything. A stale plan must not
    # overwrite an unrelated repair made after the backup was prepared.
    while IFS= read -r name; do
      allowed_name "$name"
      ordinary_item "$transaction/after/$name"
      if test -e "$root/$name" || test -L "$root/$name"; then ordinary_item "$root/$name"; fi
      matches "$root/$name" "$transaction/before/$name" || fail "runtime drift: $name"
    done < "$transaction/names"
    while IFS= read -r name; do
      # Preserve both original directories and complete desired trees. The
      # journal precedes either rename so a failed rename is also recoverable.
      cp -a "$transaction/after/$name" "$transaction/replacement"
      : > "$transaction/touched/$name"
      if test -e "$root/$name"; then mv "$root/$name" "$transaction/retired/$name"; fi
      mv "$transaction/replacement" "$root/$name"
    done < "$transaction/names"
    : > "$transaction/applied"
    ;;
  rollback)
    test ! -e "$transaction/rolled-back" || exit 0
    while IFS= read -r name; do
      allowed_name "$name"
      if test -e "$root/$name" || test -L "$root/$name"; then ordinary_item "$root/$name"; fi
      if test -f "$transaction/touched/$name"; then
        # Missing is allowed only for the gap between the two journaled moves.
        matches "$root/$name" "$transaction/after/$name" ||
          matches "$root/$name" "$transaction/before/$name" ||
          { test ! -f "$transaction/applied" && test ! -e "$root/$name" && test -e "$transaction/retired/$name"; } || fail "runtime drift prevents rollback: $name"
      else
        matches "$root/$name" "$transaction/before/$name" || fail "runtime drift prevents rollback: $name"
      fi
    done < "$transaction/names"
    while IFS= read -r name; do
      test -f "$transaction/touched/$name" || continue
      if matches "$root/$name" "$transaction/before/$name"; then continue; fi
      # Newly added code leaves the live tree but remains recoverable here.
      if test -e "$root/$name"; then mv "$root/$name" "$transaction/failed/$name"; fi
      if test -e "$transaction/before/$name"; then cp -a "$transaction/before/$name" "$root/$name"; fi
    done < "$transaction/names"
    : > "$transaction/rolled-back"
    ;;
  *) fail 'unknown release operation' ;;
esac

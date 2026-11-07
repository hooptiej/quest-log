#!/usr/bin/env bash
# quest-log #165: one-command deploy for a checkout on a Docker host (prod or dev), at parity with
# Constructicon / groundskeeper / unscrypted. It uses the checkout's own `origin` remote (a plain
# https clone of the public repo is enough -- no deploy key) and never configures credentials.
#
# Run from inside the checkout, or from anywhere (it cd's to its own parent):
#   ./scripts/deploy.sh                 fetch + reset to origin/main, back up the data, build, up -d
#   ./scripts/deploy.sh --note "TEXT"   the plain-words note for the dashboard pulse (what to try)
#   ./scripts/deploy.sh --no-backup     skip the pre-deploy data backup
#   ./scripts/deploy.sh --rebuild       build even if this commit's image already exists
#   ./scripts/deploy.sh --force         deploy even if the checkout has changes that aren't on
#                                       origin/main (they are left behind: see below)
#   ./scripts/deploy.sh --rollback TAG  run an earlier image again (no git, no build), e.g.
#                                       --rollback 1.3.0-99230d2; run without TAG to list them
#   ./scripts/deploy.sh --backup-plan   say where the data is and what the backup would do; change nothing
#   ./scripts/deploy.sh -h
#
# CONFIG comes from this install's .env (gitignored; copy .env.example). Nothing house- or
# network-specific lives in this file:
#   COMPOSE_FILE              which compose file this install runs (docker-compose.yml for prod,
#                             docker-compose.dev.yml for the dev install); docker compose reads it too
#   QUESTLOG_CONTAINER        container name (default: quest-log, or quest-log-dev for the dev file)
#   QUESTLOG_DATA_DIR         host dir mounted at /app/data (default: read from the running container)
#   QUESTLOG_DASH_URL, QUESTLOG_DASH_TOKEN_FILE   optional dashboard pulse; unset = skipped
#   QUESTLOG_DASH_LIGHT[_DEV] light id (default questlog / questlog-dev)
# The script itself writes QUESTLOG_TAG, BUILD_SHA and BUILD_DATE into .env so a plain
# `docker compose up -d` afterwards keeps running the same image.
#
# IMAGES are tagged <package.json version>-<git short sha> (quest-log:1.3.0-99230d2), so every
# deployed commit stays on the host as a rollback target (newest $IMAGE_KEEP kept). The build
# stamp (version + sha + date) is baked in and shown on /health and the page footer (#156).
#
# PRE-DEPLOY BACKUP: the state lives in one JSON file (state.json / state.dev.json) plus the
# write-token, in the data dir OUTSIDE the checkout. Every top-level file there is copied to
# <data dir>/backups/predeploy-<time>-<sha>/ and each JSON copy is checked to parse. The app
# writes state with write-temp-then-rename, so a copy taken while it runs is always a whole file.
# Newest $BACKUP_KEEP kept. Restore: stop the container, copy the files back, start it.
#
# GIT: deploy always ships origin/main. If the checkout holds work that isn't on origin/main
# (edited tracked files, local commits), it stops and lists it rather than discard it; --force
# switches to main anyway (a branch keeps its commits; uncommitted edits ARE discarded). Merge
# commits left by past `git pull`s carry no changes of their own and are simply left behind.

set -Eeuo pipefail   # -E: the ERR trap below fires inside functions too
cd "$(dirname "$0")/.."

BACKUP_KEEP=10
IMAGE_KEEP=5
BACKUP=1
REBUILD=""
FORCE=""
ROLLBACK=""
ROLLBACK_LIST=""
BACKUP_PLAN=""
NOTE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-backup|--no-snapshot) BACKUP="" ;;
    --rebuild) REBUILD=1 ;;
    --force) FORCE=1 ;;
    --backup-plan) BACKUP_PLAN=1 ;;
    --note)
      shift; NOTE="${1:-}"
      if [ -z "$NOTE" ]; then echo "deploy.sh: --note needs the text, e.g. --note \"succession tool: try succeed on a test quest\"" >&2; exit 2; fi ;;
    --rollback)
      if [ -n "${2:-}" ] && [ "${2#-}" = "$2" ]; then shift; ROLLBACK="$1"; else ROLLBACK_LIST=1; fi ;;
    -h|--help) sed -n '2,42p' "$0"; exit 0 ;;
    *) echo "deploy.sh: unknown option '$1' (see --help). Nothing changed." >&2; exit 2 ;;
  esac
  shift
done

# --- never stop silently -------------------------------------------------------------------------
# STAGE says what was being done; CHANGED lists what this run has already changed, so a failure
# message says both what broke and what state it left behind.
STAGE="starting up"
CHANGED=()
print_changed() {
  [ "${#CHANGED[@]}" -gt 0 ] || return 0
  echo "  Already done by this run before it stopped:" >&2
  local c; for c in "${CHANGED[@]}"; do echo "    - $c" >&2; done
}
on_error() {
  local code=$? line=$1
  trap - ERR
  echo "" >&2
  echo "deploy.sh FAILED while: $STAGE (line $line, exit $code)." >&2
  if [ "${#CHANGED[@]}" -eq 0 ]; then echo "  Nothing was changed on this host." >&2; else print_changed; fi
  if [ -n "${PREV_TAG:-}" ]; then
    echo "  The container was running ${PREV_IMAGE:-$PREV_TAG} before this deploy; to go back: ./scripts/deploy.sh --rollback $PREV_TAG" >&2
  fi
  exit "$code"
}
trap 'on_error $LINENO' ERR

die() { echo "deploy.sh: $*" >&2; print_changed; exit 1; }

# --- Docker access: DOCKER is `docker` or `sudo docker`; SUDO is how to run a root-only copy ------
DOCKER=(docker)
SUDO=()
detect_docker() {
  STAGE="checking Docker"
  local err
  command -v docker >/dev/null 2>&1 || die "'docker' isn't installed or on PATH. Install Docker Engine + the Compose plugin, then retry. Nothing changed."
  if [ "$(id -u)" != 0 ] && command -v sudo >/dev/null 2>&1; then SUDO=(sudo); fi
  if docker info >/dev/null 2>&1; then
    DOCKER=(docker)
  elif [ "${#SUDO[@]}" -gt 0 ] && sudo docker info >/dev/null 2>&1; then
    DOCKER=(sudo docker); echo "Docker: using 'sudo docker' ($(id -un) can't use the socket directly)."
  else
    die "can't reach the Docker daemon as $(id -un) or with sudo. Start Docker (or fix this user's docker-group/sudo access) and retry. Nothing changed."
  fi
  if ! err="$("${DOCKER[@]}" compose version 2>&1)"; then
    die "needs Docker Compose v2 ('docker compose'); '${DOCKER[*]} compose version' failed: $err -- install the Compose plugin and retry. Nothing changed."
  fi
}

# --- .env: read without sourcing (values stay literal, spaces and all) ---------------------------
ENV_FILE=".env"
envget() {
  [ -f "$ENV_FILE" ] || return 0
  local v
  v="$(sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | tr -d '\r')"
  # strip one pair of surrounding quotes, and expand a leading ~/
  case "$v" in \"*\") v="${v#\"}"; v="${v%\"}" ;; \'*\') v="${v#\'}"; v="${v%\'}" ;; esac
  case "$v" in "~/"*) v="$HOME/${v#\~/}" ;; esac
  printf '%s' "$v"
}
set_env_kv() {
  local k="$1" v="$2"
  if grep -q "^$k=" "$ENV_FILE"; then sed -i "s|^$k=.*|$k=$v|" "$ENV_FILE"; else printf '%s=%s\n' "$k" "$v" >> "$ENV_FILE"; fi
}

require_env() {
  STAGE="reading .env"
  if [ ! -f "$ENV_FILE" ]; then
    echo "deploy.sh: no .env in $PWD, so this script can't tell which install this is (prod or dev)." >&2
    echo "  Copy .env.example to .env and set at least COMPOSE_FILE:" >&2
    echo "    prod install:  COMPOSE_FILE=docker-compose.yml" >&2
    echo "    dev install:   COMPOSE_FILE=docker-compose.dev.yml" >&2
    echo "  then retry. Nothing changed." >&2
    exit 1
  fi
  COMPOSE_FILE_VAL="$(envget COMPOSE_FILE)"
  [ -n "$COMPOSE_FILE_VAL" ] || die ".env has no COMPOSE_FILE. Set COMPOSE_FILE=docker-compose.yml (prod) or COMPOSE_FILE=docker-compose.dev.yml (dev), then retry. Nothing changed."
  local f; IFS=':' read -r -a _files <<< "$COMPOSE_FILE_VAL"
  for f in "${_files[@]}"; do [ -f "$f" ] || die ".env's COMPOSE_FILE names '$f', which isn't in $PWD. Fix COMPOSE_FILE, then retry. Nothing changed."; done
  if is_dev; then
    MODE=dev; CONTAINER="$(envget QUESTLOG_CONTAINER)"; CONTAINER="${CONTAINER:-quest-log-dev}"
    IMAGE_REPO="quest-log-dev"; LIGHT="$(envget QUESTLOG_DASH_LIGHT_DEV)"; LIGHT="${LIGHT:-questlog-dev}"
  else
    MODE=prod; CONTAINER="$(envget QUESTLOG_CONTAINER)"; CONTAINER="${CONTAINER:-quest-log}"
    IMAGE_REPO="quest-log"; LIGHT="$(envget QUESTLOG_DASH_LIGHT)"; LIGHT="${LIGHT:-questlog}"
  fi
  # The compose files tag the image ${QUESTLOG_IMAGE:-<repo>}:${QUESTLOG_TAG:-local}.
  local custom; custom="$(envget QUESTLOG_IMAGE)"; [ -z "$custom" ] || IMAGE_REPO="$custom"
}
is_dev() { case "$COMPOSE_FILE_VAL" in *docker-compose.dev.yml*) return 0 ;; *) return 1 ;; esac; }

compose() { "${DOCKER[@]}" compose "$@"; }
pkg_version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1; }
container_exists() { "${DOCKER[@]}" container inspect "$CONTAINER" >/dev/null 2>&1; }
container_running() { [ "$("${DOCKER[@]}" container inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)" = "true" ]; }
image_exists() { "${DOCKER[@]}" image inspect "$1" >/dev/null 2>&1; }

# The image the container runs now, as a ref and as a tag in IMAGE_REPO (empty when none).
PREV_IMAGE=""
PREV_TAG=""
note_current_image() {
  container_exists || return 0
  PREV_IMAGE="$("${DOCKER[@]}" container inspect -f '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || true)"
  case "$PREV_IMAGE" in "$IMAGE_REPO":*) PREV_TAG="${PREV_IMAGE#"$IMAGE_REPO":}" ;; esac
}

# First deploy with this script: the running image has no tag in IMAGE_REPO (it was built by a
# plain compose under the old name), so give it one, or there'd be nothing to roll back to.
mark_rollback_point() {
  [ -n "$PREV_IMAGE" ] || return 0
  [ -z "$PREV_TAG" ] || return 0
  local id short
  id="$("${DOCKER[@]}" container inspect -f '{{.Image}}' "$CONTAINER")"
  short="$(printf '%s' "${id#sha256:}" | cut -c1-12)"
  PREV_TAG="pre-$short"
  "${DOCKER[@]}" tag "$id" "$IMAGE_REPO:$PREV_TAG"
  CHANGED+=("tagged the image the container was running ($PREV_IMAGE) as $IMAGE_REPO:$PREV_TAG")
  echo "Rollback point: the running image ($PREV_IMAGE) is now also $IMAGE_REPO:$PREV_TAG."
}

# --- the data dir and its backup -----------------------------------------------------------------
DATA_DIR=""
resolve_data_dir() {
  DATA_DIR="$(envget QUESTLOG_DATA_DIR)"
  DATA_DIR_FROM=".env QUESTLOG_DATA_DIR"
  if [ -z "$DATA_DIR" ] && container_exists; then
    DATA_DIR="$("${DOCKER[@]}" container inspect -f '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Source}}{{end}}{{end}}' "$CONTAINER" 2>/dev/null || true)"
    DATA_DIR_FROM="the /app/data mount of container '$CONTAINER'"
  fi
}

# cp/mkdir as this user, falling back to sudo for the root-owned write-token.
as_needed() { "$@" 2>/dev/null || { [ "${#SUDO[@]}" -gt 0 ] && "${SUDO[@]}" "$@"; }; }

json_ok() {
  # A copied state file must parse. python3 on the host if it has one, else node in the container.
  if command -v python3 >/dev/null 2>&1; then
    as_needed python3 -c 'import json,sys; json.load(open(sys.argv[1], encoding="utf-8"))' "$1"
  elif container_running; then
    "${DOCKER[@]}" exec "$CONTAINER" node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "/app/data/${1#"$DATA_DIR"/}"
  else
    echo "  (couldn't check $1 parses: no python3 here and the container isn't running)"; return 0
  fi
}

# Run before anything changes, so a backup that can't happen stops the deploy up front.
check_backup_possible() {
  [ -n "$BACKUP" ] || return 0
  STAGE="finding the data dir"
  resolve_data_dir
  if [ -z "$DATA_DIR" ]; then
    die "can't tell where the data lives: QUESTLOG_DATA_DIR isn't set in .env and there's no container '$CONTAINER' to read its /app/data mount from. Set QUESTLOG_DATA_DIR, or re-run with --no-backup if there's genuinely nothing to keep."
  fi
  [ -d "$DATA_DIR" ] || die "the data dir '$DATA_DIR' (from $DATA_DIR_FROM) doesn't exist. Fix QUESTLOG_DATA_DIR in .env, then retry."
}

do_backup() {
  if [ -z "$BACKUP" ]; then echo "Pre-deploy backup: skipped (--no-backup)."; return 0; fi
  check_backup_possible
  STAGE="backing up the data dir"
  local files=() f
  while IFS= read -r -d '' f; do
    case "$f" in *.tmp-*) continue ;; esac  # a state write in flight; the real file is copied instead
    files+=("$f")
  done < <(as_needed find "$DATA_DIR" -maxdepth 1 -type f -print0)
  if [ "${#files[@]}" -eq 0 ]; then echo "Pre-deploy backup: $DATA_DIR is empty (first deploy?), nothing to back up."; return 0; fi
  local name dest
  # Named for the checkout's commit before this deploy moved it (normally what's running).
  name="predeploy-$(date +%Y%m%d-%H%M%S)-${BEFORE_SHA:-nogit}"
  dest="$DATA_DIR/backups/$name"
  as_needed mkdir -p "$dest"
  as_needed cp -p "${files[@]}" "$dest/"
  CHANGED+=("backed up the data to $dest")
  local checked=0
  for f in "${files[@]}"; do
    case "$f" in *.json) ;; *) continue ;; esac
    json_ok "$dest/$(basename "$f")" || die "the backup copy $dest/$(basename "$f") doesn't parse as JSON, so the live file may be damaged. Look at it before deploying."
    checked=$((checked + 1))
  done
  echo "Pre-deploy backup: ${#files[@]} file(s) from $DATA_DIR ($DATA_DIR_FROM) -> $dest ($checked JSON file(s) checked)."
  echo "  Restore: stop the container, copy them back into $DATA_DIR, start it."
  # Names start with a sortable timestamp, so name order is age order.
  as_needed find "$DATA_DIR/backups" -mindepth 1 -maxdepth 1 -type d -name 'predeploy-*' | sort -r | tail -n "+$((BACKUP_KEEP + 1))" \
    | while IFS= read -r old; do
        if as_needed rm -rf "$old"; then echo "  pruned $old"; else echo "  couldn't prune $old (left in place)" >&2; fi
      done
}

# --- health: ask the app itself, from inside its container ---------------------------------------
# Prints "status version build built_at". The app is plain HTTP when DISABLE_TLS=1, else self-signed
# HTTPS; try both.
HEALTH_JS='const p=process.env.PORT||4242;const get=(u)=>fetch(u).then((r)=>r.json());get("http://127.0.0.1:"+p+"/health").catch(()=>get("https://127.0.0.1:"+p+"/health")).then((j)=>console.log([j.status,j.version,j.build,j.built_at].join(" "))).catch((e)=>{console.error(String(e));process.exit(1)})'
HEALTH=""
wait_healthy() {
  local i
  HEALTH=""
  for i in $(seq 1 30); do
    if HEALTH="$("${DOCKER[@]}" exec -e NODE_TLS_REJECT_UNAUTHORIZED=0 "$CONTAINER" node -e "$HEALTH_JS" 2>/dev/null)"; then
      [ "${HEALTH%% *}" = ok ] && return 0
    fi
    sleep 2
  done
  return 1
}

# --- dashboard pulse (optional, never fatal) -----------------------------------------------------
json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\000-\037'; }
pulse_dashboard() {
  local url token_file build="$1" note="$2"
  url="$(envget QUESTLOG_DASH_URL)"; token_file="$(envget QUESTLOG_DASH_TOKEN_FILE)"
  if [ -z "$url" ] || [ -z "$token_file" ]; then
    echo "Dashboard pulse: skipped (set QUESTLOG_DASH_URL and QUESTLOG_DASH_TOKEN_FILE in .env to enable)."
    return 0
  fi
  if ! command -v curl >/dev/null 2>&1; then echo "Dashboard pulse: skipped (curl isn't installed on this host). The deploy itself succeeded." >&2; return 0; fi
  if [ ! -r "$token_file" ]; then echo "Dashboard pulse: skipped (token file $token_file isn't readable by $(id -un)). The deploy itself succeeded." >&2; return 0; fi
  local body err
  body="{\"on\": true, \"build\": \"$(json_escape "$build")\", \"note\": \"$(json_escape "$note")\"}"
  if err="$(curl -fsS -m 10 -X POST -H "Authorization: Bearer $(cat "$token_file")" -H "Content-Type: application/json" \
       -d "$body" "${url%/}/api/pulse/$LIGHT" 2>&1 >/dev/null)"; then
    echo "Dashboard pulse: lit '$LIGHT' (build $build)."
  else
    echo "Dashboard pulse: POST to ${url%/}/api/pulse/$LIGHT failed ($err). The deploy itself succeeded; light it by hand if you want it." >&2
  fi
}

prune_image_tags() {
  STAGE="pruning old images"
  # Only <version>-<sha> tags this script made; never the one just deployed, never pre-* / local.
  # (awk, not grep: no matching tags is normal, not a failure.)
  "${DOCKER[@]}" image ls "$IMAGE_REPO" --format '{{.CreatedAt}}	{{.Tag}}' \
    | sort -r | cut -f2 | awk -v cur="$1" '/^[0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]+$/ && $0 != cur' \
    | tail -n "+$IMAGE_KEEP" \
    | while IFS= read -r tag; do
        if "${DOCKER[@]}" image rm "$IMAGE_REPO:$tag" >/dev/null 2>&1; then echo "Image pruned: $IMAGE_REPO:$tag"
        else echo "Image kept: $IMAGE_REPO:$tag (still in use by a container)"; fi
      done
}

list_rollback_targets() {
  echo "Images of $IMAGE_REPO on this host (newest first; --rollback <TAG>):"
  local out
  out="$("${DOCKER[@]}" image ls "$IMAGE_REPO" --format '  {{.Tag}}  ({{.CreatedSince}})' | awk '!/<none>/')"
  if [ -n "$out" ]; then printf '%s\n' "$out"; else echo "  (none yet -- the first deploy with this script tags the running image as $IMAGE_REPO:pre-<id>)"; fi
}

# =================================================================================================
detect_docker
require_env
note_current_image
BEFORE_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
echo "quest-log deploy: $MODE install, container '$CONTAINER', compose '$COMPOSE_FILE_VAL', images $IMAGE_REPO:<tag>."

if [ -n "$BACKUP_PLAN" ]; then
  resolve_data_dir
  if [ -n "$DATA_DIR" ]; then
    echo "Pre-deploy backup plan: copy the top-level files of $DATA_DIR (from $DATA_DIR_FROM) to $DATA_DIR/backups/predeploy-<time>-<sha>/, check each JSON copy parses, keep the newest $BACKUP_KEEP."
    as_needed ls -la "$DATA_DIR" || echo "  (couldn't list $DATA_DIR as $(id -un), with or without sudo)"
  else
    echo "Pre-deploy backup plan: NONE POSSIBLE -- QUESTLOG_DATA_DIR isn't set and there's no container '$CONTAINER' to read the mount from. A deploy would stop here unless --no-backup."
  fi
  echo "Currently running: ${PREV_IMAGE:-(no container)}"
  exit 0
fi

if [ -n "$ROLLBACK_LIST" ]; then list_rollback_targets; exit 0; fi

if [ -n "$ROLLBACK" ]; then
  STAGE="rolling back"
  ROLLBACK="${ROLLBACK#"$IMAGE_REPO":}"
  if ! image_exists "$IMAGE_REPO:$ROLLBACK"; then
    echo "deploy.sh: there's no image $IMAGE_REPO:$ROLLBACK on this host. Nothing changed." >&2
    list_rollback_targets >&2
    exit 1
  fi
  do_backup
  set_env_kv QUESTLOG_TAG "$ROLLBACK"
  CHANGED+=("set QUESTLOG_TAG=$ROLLBACK in .env")
  echo "Rolling back to $IMAGE_REPO:$ROLLBACK (the data isn't rolled back; if the newer build changed it in a way the old code can't read, restore the pre-deploy backup too)..."
  STAGE="starting $IMAGE_REPO:$ROLLBACK"
  compose up -d --no-build
  CHANGED+=("recreated '$CONTAINER' on $IMAGE_REPO:$ROLLBACK")
  STAGE="waiting for /health"
  if wait_healthy; then echo "Healthy: $HEALTH  (status version build built_at)"
  else die "'$CONTAINER' didn't answer /health with status ok within a minute after the rollback. Check: ${DOCKER[*]} logs $CONTAINER"; fi
  exit 0
fi

check_backup_possible

# --- git: ship exactly origin/main ---------------------------------------------------------------
STAGE="checking the git checkout"
git rev-parse --git-dir >/dev/null 2>&1 || die "$PWD is not a git checkout, so there's nothing to fetch and build. Nothing changed."
STAGE="fetching origin"
if ! err="$(git fetch --quiet origin 2>&1)"; then
  die "couldn't fetch from origin ($(git remote get-url origin 2>/dev/null || echo 'no origin remote')): $err -- check the network and the remote, then retry. Nothing changed."
fi
git rev-parse --verify --quiet origin/main >/dev/null || die "origin has no main branch to deploy. Nothing changed."

STAGE="checking for work that isn't on origin/main"
branch="$(git symbolic-ref --quiet --short HEAD || echo '(detached HEAD)')"
dirty="$(git status --porcelain --untracked-files=no)"
# Content committed on <ref> that origin/main doesn't have. Merge commits from past `git pull`s
# whose tree matches what they merged show up as nothing here, which is the point.
unshipped_on() { git diff --stat "$(git merge-base "$1" origin/main)" "$1"; }
unshipped="$(unshipped_on HEAD)"
unshipped_main=""
if [ "$branch" != "main" ] && git rev-parse --verify --quiet refs/heads/main >/dev/null; then
  unshipped_main="$(unshipped_on main)"   # `checkout -B main` below would move this branch
fi
if [ -n "$dirty" ] || [ -n "$unshipped" ] || [ -n "$unshipped_main" ]; then
  echo "deploy.sh: this checkout (on $branch) holds work that isn't on origin/main:" >&2
  if [ -n "$dirty" ]; then echo "  uncommitted changes to tracked files:" >&2; printf '%s\n' "$dirty" | sed 's/^/    /' >&2; fi
  if [ -n "$unshipped" ]; then
    echo "  committed on $branch but not on origin/main:" >&2
    git log --oneline --no-merges origin/main..HEAD | sed 's/^/    /' >&2
    printf '%s\n' "$unshipped" | sed 's/^/    /' >&2
  fi
  if [ -n "$unshipped_main" ]; then
    echo "  committed on the local main branch but not on origin/main (switching to main would reset it):" >&2
    git log --oneline --no-merges origin/main..main | sed 's/^/    /' >&2
  fi
  if [ -z "$FORCE" ]; then
    echo "  Deploy ships origin/main, so this would be left behind. Push/merge it (or stash it), or re-run with" >&2
    echo "  --force to deploy origin/main anyway (other branches keep their commits; uncommitted edits and" >&2
    echo "  local-only main commits are dropped, though git's reflog still has the commits). Nothing changed." >&2
    exit 1
  fi
  echo "  --force: deploying origin/main anyway." >&2
fi

after="$(git rev-parse --short origin/main)"
STAGE="moving the checkout to origin/main"
if [ "$branch" = "main" ]; then
  git reset --quiet --hard origin/main
else
  git checkout --quiet --force -B main origin/main
fi
if [ "$BEFORE_SHA" = "$after" ] && [ "$branch" = "main" ]; then
  echo "Checkout: already at origin/main ($after)."
else
  echo "Checkout: $branch@$BEFORE_SHA -> main@$after."
  CHANGED+=("moved the checkout from $branch@$BEFORE_SHA to main@$after")
fi

VERSION="$(pkg_version)"
[ -n "$VERSION" ] || die "couldn't read \"version\" from package.json."
SHA="$(git rev-parse --short HEAD)"
TAG="$VERSION-$SHA"
BUILD_DATE="$(date -u +%Y-%m-%d)"

if [ "$PREV_IMAGE" = "$IMAGE_REPO:$TAG" ] && container_running && [ -z "$REBUILD" ]; then
  echo "Already deployed: '$CONTAINER' is running $IMAGE_REPO:$TAG. Nothing to do (--rebuild to build and restart it anyway)."
  STAGE="checking /health"
  if wait_healthy; then echo "Healthy: $HEALTH  (status version build built_at)"; fi
  exit 0
fi

STAGE="marking a rollback point"
# --rebuild of the tag that's running: the build is about to take that tag over, so the image
# running now gets its own pre-<id> tag instead (it would otherwise be left untagged).
[ "$PREV_TAG" != "$TAG" ] || PREV_TAG=""
mark_rollback_point
do_backup

STAGE="writing the image tag and build stamp into .env"
# BUILD_DATE in .env is the image's build date; on a reuse of an existing image it is left alone.
set_env_kv QUESTLOG_TAG "$TAG"
CHANGED+=("set QUESTLOG_TAG=$TAG in .env")
if [ -n "$REBUILD" ] || ! image_exists "$IMAGE_REPO:$TAG"; then
  set_env_kv BUILD_SHA "$SHA"
  set_env_kv BUILD_DATE "$BUILD_DATE"
  STAGE="building $IMAGE_REPO:$TAG"
  echo "Building $IMAGE_REPO:$TAG (build $SHA, $BUILD_DATE)..."
  compose build
  CHANGED+=("built $IMAGE_REPO:$TAG")
else
  echo "Image $IMAGE_REPO:$TAG already exists on this host; reusing it (--rebuild to build it again)."
fi

STAGE="starting $IMAGE_REPO:$TAG"
compose up -d --no-build
CHANGED+=("recreated '$CONTAINER' on $IMAGE_REPO:$TAG")

STAGE="waiting for /health"
if ! wait_healthy; then
  die "'$CONTAINER' is up on $IMAGE_REPO:$TAG but didn't answer /health with status ok within a minute. Check: ${DOCKER[*]} logs $CONTAINER${PREV_TAG:+ -- or go back: ./scripts/deploy.sh --rollback $PREV_TAG}"
fi
running_build="$(printf '%s' "$HEALTH" | cut -d' ' -f3)"
if [ "$running_build" != "$SHA" ]; then
  die "'$CONTAINER' is healthy but /health reports build '$running_build', not $SHA -- the container isn't running the image just built. Check: ${DOCKER[*]} ps / compose config.${PREV_TAG:+ Or go back: ./scripts/deploy.sh --rollback $PREV_TAG}"
fi
echo "Healthy: $HEALTH  (status version build built_at)"

prune_image_tags "$TAG"

STAGE="pulsing the dashboard"
[ -n "$NOTE" ] || NOTE="quest-log $VERSION deployed: $(git log -1 --format=%s)"
pulse_dashboard "$TAG" "$NOTE"
if [ -n "$PREV_TAG" ]; then
  echo "Done: $MODE is on $IMAGE_REPO:$TAG. Rollback: ./scripts/deploy.sh --rollback $PREV_TAG"
else
  echo "Done: $MODE is on $IMAGE_REPO:$TAG. (No earlier image was running; ./scripts/deploy.sh --rollback lists what's on this host.)"
fi

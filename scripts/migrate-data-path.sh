#!/bin/bash
# Migrate quest-log data and certs from the git checkout to a dedicated host path
# This script MUST be run before deploying the updated docker-compose.yml
# that points volumes to /mnt/Storage Pool/quest-log-data/{data,certs}

set -e

CHECKOUT_DATA_DIR="./data"
CHECKOUT_CERTS_DIR="./certs"
HOST_DATA_DIR="/mnt/Storage Pool/quest-log-data"
HOST_DATA_MOUNT="$HOST_DATA_DIR/data"
HOST_CERTS_MOUNT="$HOST_DATA_DIR/certs"

echo "=== QuestLog Data Migration ==="
echo "This script moves data/state.json and certs from the checkout to a dedicated host path."
echo "This MUST run before the first deploy with the updated docker-compose.yml."
echo ""

# Check if we're in the right directory
if [ ! -f "docker-compose.yml" ]; then
    echo "ERROR: docker-compose.yml not found. Run this script from the quest-log checkout root."
    exit 1
fi

# Check if the new host directory already exists and has data
if [ -d "$HOST_DATA_MOUNT" ] && [ "$(ls -A "$HOST_DATA_MOUNT" 2>/dev/null | wc -l)" -gt 0 ]; then
    echo "WARNING: $HOST_DATA_MOUNT already exists and is not empty."
    echo "Skipping migration (data may already be migrated)."
    exit 0
fi

# Check if there's data to migrate in the checkout
if [ ! -d "$CHECKOUT_DATA_DIR" ]; then
    echo "WARNING: $CHECKOUT_DATA_DIR does not exist in checkout."
    echo "This may be a fresh deployment or the data has already been moved."
    echo "If this is intentional, no migration is needed."
    exit 0
fi

# Create the host directory if it doesn't exist. The parent (e.g.
# /mnt/Storage Pool) is typically root-owned (mode 755) on a TrueNAS box, so
# a plain mkdir here fails with Permission denied for a non-root user even
# though that user has passwordless sudo -- fall back to sudo, then hand
# ownership back so the rest of this script (running as the normal user)
# can write into it.
echo "Creating host directory: $HOST_DATA_DIR"
if ! mkdir -p "$HOST_DATA_DIR" 2>/dev/null; then
    echo "  (plain mkdir failed, retrying with sudo)"
    sudo mkdir -p "$HOST_DATA_DIR"
    sudo chown "$(id -u):$(id -g)" "$HOST_DATA_DIR"
fi

# Migrate data directory. write-token is deliberately root-owned, mode 600
# (see server.js) -- a plain `cp -r` as a non-root user can create the
# destination tree but can't read that one file, and fails partway through.
# `sudo cp -rp` reads everything regardless of ownership, and -p preserves
# each file's original owner/permissions on the copy (only meaningful when
# the copy itself runs as root, which sudo gives us here) -- so state.json
# etc. land hoop-owned same as before, and write-token stays root-owned
# without a separate special case.
if [ -d "$CHECKOUT_DATA_DIR" ]; then
    echo "Copying data directory from $CHECKOUT_DATA_DIR to $HOST_DATA_MOUNT"
    sudo cp -rp "$CHECKOUT_DATA_DIR" "$HOST_DATA_MOUNT"
    echo "✓ Data directory migrated"
else
    echo "! $CHECKOUT_DATA_DIR not found (fresh deployment?)"
    mkdir -p "$HOST_DATA_MOUNT"
fi

# Migrate certs directory if it exists
if [ -d "$CHECKOUT_CERTS_DIR" ]; then
    echo "Copying certs directory from $CHECKOUT_CERTS_DIR to $HOST_CERTS_MOUNT"
    sudo cp -rp "$CHECKOUT_CERTS_DIR" "$HOST_CERTS_MOUNT"
    echo "✓ Certs directory migrated"
else
    echo "! $CHECKOUT_CERTS_DIR not found (certs will be generated on first boot)"
    mkdir -p "$HOST_CERTS_MOUNT"
fi

echo ""
echo "=== Migration Complete ==="
echo "Data and certs are now at:"
echo "  - $HOST_DATA_MOUNT"
echo "  - $HOST_CERTS_MOUNT"
echo ""
echo "You may now safely:"
echo "  1. Run: git pull"
echo "  2. Run: docker compose up -d --build"
echo ""
echo "The checkout's ./data and ./certs can be safely deleted after verification that the"
echo "new deployment is working correctly and the new host paths have the data."

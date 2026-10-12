#!/bin/sh
MODDIR="${0%/*}"

# Wait until boot completed
until [ "$(getprop sys.boot_completed)" = "1" ] && [ -f /data/system/packages.list ]; do
	sleep 1
done

# Re-apply per-app / per-channel rules (migrates the old isolated.json on first run)
sh "$MODDIR/system/bin/netswitcher" apply

#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cargo build --release --locked --manifest-path "$root/Cargo.toml" --target-dir "$root/target"
bin="$HOME/.local/bin"
mkdir -p "$bin"
temporary=$(mktemp "$bin/.herdr-pocket.XXXXXX")
trap 'rm -f "$temporary"' EXIT HUP INT TERM
install -m 755 "$root/target/release/herdr-pocket" "$temporary"
mv -f "$temporary" "$bin/herdr-pocket"
printf 'Installed %s/herdr-pocket\n' "$bin"

#!/bin/sh
# Stage the two catalogue CSVs into the Docker build context.
#
# data/ is symlinks into the collection repo, and Docker will not follow a symlink that
# points outside the build context -- so they are dereferenced (cp -L) into build/catalogue/.
# That directory is gitignored on purpose: the collection repo stays the single source of
# truth and the CSVs are never committed here in a second copy.
#
# The catalogue is baked into the image (README open decision #1), so the image is only as
# current as its last build. STAGED records when, so a running task can be traced back.
set -eu
src="${LAP_STAGE_FROM:-data}"
out="build/catalogue"
mkdir -p "$out"
cp -L "$src/serving_files.csv" "$src/councils_master.csv" "$out/"
printf 'staged %s from %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$src" > "$out/STAGED"
echo "staged $(( $(wc -l < "$out/serving_files.csv") - 1 )) councils from $src/ into $out/"

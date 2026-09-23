#!/usr/bin/env sh
# Materialize the reconciled package in the current checkout. No Git mutation.
set -eu
repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"
node docs/agent-team-bootstrap/install.cjs

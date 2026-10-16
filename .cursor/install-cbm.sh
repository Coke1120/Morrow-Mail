#!/usr/bin/env bash
# Non-interactive login shells skip ~/.bashrc, so the binary is also linked into /usr/local/bin.
set -euo pipefail

dest="${HOME}/.local/share/codebase-memory-mcp"
curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh \
  | bash -s -- --skip-config --dir "$dest"

bin="${dest}/codebase-memory-mcp"
test -x "$bin"
sudo ln -sfn "$bin" /usr/local/bin/codebase-memory-mcp
"$bin" --version

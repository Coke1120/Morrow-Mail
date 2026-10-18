# Codebase Memory on the Morrow Mail Cloud Agent

Pilot for the **Morrow Mail** environment only. Do not copy this into other repos.

`.cursor/environment.json` runs `.cursor/install-cbm.sh` on each Build. The official installer is called with `--skip-config` and `--dir $HOME/.local/share/codebase-memory-mcp`. Cloud Agent VMs use the `ubuntu` user, so the binary is:

`/home/ubuntu/.local/share/codebase-memory-mcp/codebase-memory-mcp`

A symlink at `/usr/local/bin/codebase-memory-mcp` puts that binary on `PATH`. This repo has no other install step; Node on the image is left alone.

`.cursor/mcp.json` registers the stdio server `codebase-memory-mcp` at that path. A binary baked into a Build does not expose tools until the Cloud Agents dashboard MCP list includes the same stdio server. Add it under [cursor.com/agents](https://cursor.com/agents) MCP if it is not listed there yet.

Indexes written by this binary stay on the Cloud Agent VM / Build disk. They are not shared with the Grok Bot box.

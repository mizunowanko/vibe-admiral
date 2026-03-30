#!/bin/bash
# Wrapper for stub-cli.ts — called by Engine's ProcessManager as CLAUDE_CLI_PATH.
# Delegates to npx tsx with the real stub script path.
# STUB_CLI_TSX_PATH must be set by global-setup.ts.

exec npx tsx "${STUB_CLI_TSX_PATH}" "$@"

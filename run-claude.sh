#!/bin/bash
# Wrapper script to run Claude CLI and capture output
cd "$1"
shift
exec /Users/thomas/.local/bin/claude "$@" 2>&1

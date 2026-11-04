#!/usr/bin/env bash
# Run a command with MODEL_API_KEY loaded from ~/.config/meta-model-api/key (never printed).
set -euo pipefail
KEY_FILE="${META_KEY_FILE:-$HOME/.config/meta-model-api/key}"
if [[ -s "$KEY_FILE" ]]; then
  MODEL_API_KEY="$(tr -d '[:space:]' < "$KEY_FILE")"
  export MODEL_API_KEY
else
  echo "with-key: $KEY_FILE missing → running in mock mode" >&2
  export OFFLOAD_MOCK=1
fi
exec "$@"

#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MODEL="${OLLAMA_MODEL:-}"
if [[ -z "$MODEL" && -f "$ROOT/.env" ]]; then
  MODEL="$(sed -n -E 's/^[[:space:]]*OLLAMA_MODEL[[:space:]]*=[[:space:]]*([^[:space:]#]+).*/\1/p' "$ROOT/.env" | head -n 1)"
  MODEL="${MODEL%\"}"
  MODEL="${MODEL#\"}"
fi
MODEL="${MODEL:-qwen3:4b-instruct-2507-q4_K_M}"
OLLAMA_BIN="$ROOT/data/local/ollama-runtime/bin/ollama"
if [[ ! -x "$OLLAMA_BIN" ]]; then
  echo "The project-local Ollama runtime is missing. Run: npm run model:install:local" >&2
  exit 1
fi

export HOME="$ROOT/data/local/ollama-home"
export OLLAMA_HOST=127.0.0.1:11434
export OLLAMA_MODELS="$ROOT/data/local/ollama-models"
export OLLAMA_NO_CLOUD=1

printf 'Downloading Ollama model: %s\n' "$MODEL"
exec "$OLLAMA_BIN" pull "$MODEL"

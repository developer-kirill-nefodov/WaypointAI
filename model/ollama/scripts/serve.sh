#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
export HOME="$ROOT/data/local/ollama-home"
export OLLAMA_HOST=127.0.0.1:11434
export OLLAMA_MODELS="$ROOT/data/local/ollama-models"
export OLLAMA_NO_CLOUD=1
export OLLAMA_NUM_PARALLEL=1
export OLLAMA_MAX_LOADED_MODELS=1

exec "$ROOT/data/local/ollama-runtime/bin/ollama" serve

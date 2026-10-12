#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
export HOME="$ROOT/data/local/ollama-home"
export OLLAMA_HOST=127.0.0.1:11434
export OLLAMA_MODELS="$ROOT/data/local/ollama-models"
export OLLAMA_NO_CLOUD=1
export OLLAMA_NUM_PARALLEL=1
export OLLAMA_MAX_LOADED_MODELS=1

# Optional Vulkan GPU offload, including integrated GPUs such as Intel Arc.
# Read from the shell environment first, then from the repository .env; disabled by default.
read_env_flag() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "$value" && -f "$ROOT/.env" ]]; then
    value="$(grep -E "^${name}=" "$ROOT/.env" | tail -n 1 | cut -d= -f2- | tr -d '[:space:]"' || true)"
  fi
  [[ "$value" == "1" || "$value" == "true" ]]
}
unset OLLAMA_VULKAN OLLAMA_IGPU_ENABLE
if read_env_flag OLLAMA_VULKAN; then
  export OLLAMA_VULKAN=1
  echo "Vulkan GPU offload is enabled."
fi
if read_env_flag OLLAMA_IGPU_ENABLE; then
  export OLLAMA_IGPU_ENABLE=1
fi

exec "$ROOT/data/local/ollama-runtime/bin/ollama" serve

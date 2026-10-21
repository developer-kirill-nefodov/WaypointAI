#!/usr/bin/env bash
# Registers a fine-tuned router in the local Ollama runtime, from a merged safetensors folder (train_router.py,
# merge_adapter.py) or from a ready GGUF file (an imported package):
#   bash model/training/publish_router.sh data/local/training/runs/<id>/merged waypoint-router:<id>
#   bash model/training/publish_router.sh data/local/training/runs/<id>/router-q8_0.gguf waypoint-router:<id>
# This Ollama imports safetensors only through MLX (not on Linux) and no longer takes LoRA adapters, so the merged
# model is converted to GGUF with llama.cpp's converter (Q8_0: small, with little loss for a small model) first.
# Prints "STAGE converting" and "STAGE creating" lines, which the backend shows as publishing stages.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NAME="$2"
[[ "$NAME" =~ ^[a-z0-9][a-z0-9._-]*(:[a-z0-9._-]+)?$ ]] || { echo "invalid model name: $NAME" >&2; exit 2; }
if [[ -f "$1" && "$1" == *.gguf ]]; then
  GGUF="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
else
  MERGED="$(cd "$1" && pwd)"
  [[ -f "$MERGED/config.json" ]] || { echo "not a merged model folder: $MERGED" >&2; exit 2; }
  CONVERTER="$ROOT/model/training/llama.cpp/convert_hf_to_gguf.py"
  [[ -f "$CONVERTER" ]] || { echo "GGUF converter missing: see model/training/README.md" >&2; exit 2; }
  GGUF="$MERGED/../router-q8_0.gguf"
  echo "STAGE converting"
  "$ROOT/model/training/.venv/bin/python" "$CONVERTER" "$MERGED" --outfile "$GGUF" --outtype q8_0 >/dev/null
fi
echo "STAGE creating"

export HOME="$ROOT/data/local/ollama-home"
export OLLAMA_HOST=127.0.0.1:11434
MODELFILE="$(mktemp)"
trap 'rm -f "$MODELFILE"' EXIT
cat > "$MODELFILE" <<MODELFILE_END
FROM $GGUF
PARAMETER temperature 0
PARAMETER num_ctx 2048
MODELFILE_END
"$ROOT/data/local/ollama-runtime/bin/ollama" create "$NAME" -f "$MODELFILE" >/dev/null

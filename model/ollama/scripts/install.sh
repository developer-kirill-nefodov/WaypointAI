#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUNTIME_DIR="$ROOT/data/local/ollama-runtime"
ARCHIVE="$ROOT/data/local/ollama-linux-amd64.tar.zst"

if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "This installer currently supports Linux x86_64 only." >&2
  exit 1
fi

mkdir -p "$RUNTIME_DIR" "$ROOT/data/local/ollama-models" "$ROOT/data/local/ollama-home"
if [[ ! -x "$RUNTIME_DIR/bin/ollama" ]]; then
  command -v curl >/dev/null || { echo "curl is required." >&2; exit 1; }
  command -v tar >/dev/null || { echo "tar is required." >&2; exit 1; }
  command -v zstd >/dev/null || { echo "zstd is required to unpack the Ollama archive." >&2; exit 1; }
  curl -fL --retry 3 -o "$ARCHIVE" https://ollama.com/download/ollama-linux-amd64.tar.zst
  tar --zstd -xf "$ARCHIVE" -C "$RUNTIME_DIR"
fi

"$RUNTIME_DIR/bin/ollama" --version || true
rm -f "$ARCHIVE"
echo "Ollama is installed under $RUNTIME_DIR. Run: npm run model:serve"

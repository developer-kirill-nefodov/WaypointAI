"""Merges a LoRA adapter (for example an imported one) into its base model, so it can be published to Ollama.

    python merge_adapter.py --adapter runs/abc/adapter --base Qwen/Qwen3-0.6B --out runs/abc/merged

Only safetensors weights are read (the backend accepts no other format). Progress is printed as JSON lines.
"""

import argparse
import json
import sys


def emit(event: str, **fields) -> None:
    print(json.dumps({"event": event, **fields}), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--adapter", required=True)
    parser.add_argument("--base", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    emit("status", phase="merging")
    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(args.base)
    base = AutoModelForCausalLM.from_pretrained(args.base, torch_dtype=torch.float32)
    model = PeftModel.from_pretrained(base, args.adapter, use_safetensors=True)
    merged = model.merge_and_unload()
    merged.save_pretrained(args.out, safe_serialization=True)
    tokenizer.save_pretrained(args.out)
    emit("done", merged=args.out)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:  # Reported to the backend as one line; the traceback goes to stderr.
        import traceback
        traceback.print_exc()
        emit("error", message=str(error)[:300])
        sys.exit(1)

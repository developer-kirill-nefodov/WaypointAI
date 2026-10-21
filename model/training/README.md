# Router fine-tuning (LoRA)

The router picks the first tool call of a chat turn from a short prompt and answers with JSON
(`backend/src/assistant/router.ts`). A small model fine-tuned on this exact task can replace the main model for that
step: the router prompt is a few hundred tokens instead of several thousand, so the first step is much faster.

1. **Dataset.** On the Model page (tab *Fine-tuning*), build the dataset. It is built from synthetic questions
   generated from the local database (a different seed than the benchmark), from examples an OpenAI model (the
   teacher, `TEACHER_MODEL`) wrote in batches that a person accepted, and from journal turns a person confirmed;
   every question that is also in the benchmark is left out. It is written to
   `data/local/training/router-dataset.jsonl`. No personal data: synthetic questions and reviewed requests only.
2. **Environment** (once, about 1–2 GB; CPU wheels):

   ```bash
   python3 -m venv model/training/.venv
   model/training/.venv/bin/pip install -r model/training/requirements.txt
   ```

   Without the `python3-venv` package (Ubuntu), use [uv](https://docs.astral.sh/uv/) instead:
   `uv venv --python 3.12 model/training/.venv && VIRTUAL_ENV=model/training/.venv uv pip install -r model/training/requirements.txt --index-strategy unsafe-best-match`.

   Publishing needs llama.cpp's GGUF converter (this Ollama imports safetensors only through MLX, which Linux lacks,
   and no longer accepts LoRA adapters):

   ```bash
   git clone --depth 1 --branch b6000 --filter=blob:none --sparse https://github.com/ggml-org/llama.cpp.git model/training/llama.cpp
   git -C model/training/llama.cpp sparse-checkout set --no-cone /convert_hf_to_gguf.py /gguf-py
   VIRTUAL_ENV=model/training/.venv uv pip install -e model/training/llama.cpp/gguf-py sentencepiece
   ```

   The base model (for example `Qwen/Qwen3-0.6B`, about 1.2 GB) is downloaded from Hugging Face on the first run.
   On a machine without an NVIDIA GPU, training runs on the CPU (an Intel GPU is used when PyTorch reports `xpu`).
   Training can also run elsewhere (for example a cloud GPU): the dataset contains no user data.
3. **Training.** Start it on the page, or run:

   ```bash
   model/training/.venv/bin/python model/training/train_router.py \
     --data data/local/training/router-dataset.jsonl --out data/local/training/runs/manual --base Qwen/Qwen3-0.6B
   ```

   It prints one JSON line per step (`loss`, `validation_loss`, `eta_seconds`) and saves the LoRA adapter and the
   merged model. Measured on an Intel Core Ultra 7 155H CPU: about 7 s per example per epoch for Qwen3-0.6B.
4. **Publish** the merged model to Ollama (converted to GGUF Q8_0):

   ```bash
   bash model/training/publish_router.sh data/local/training/runs/manual/merged waypoint-router:manual
   ```

   A ready GGUF file can be passed instead of the folder. An adapter alone (for example from an imported package) is
   merged into its base model first: `merge_adapter.py --adapter <run>/adapter --base Qwen/Qwen3-0.6B --out <run>/merged`.
   On the page, publishing and the router benchmark can follow training automatically.

5. **Compare** on the benchmark in *router* mode with that model, against the base small model and the main model.
   Use it only if it is at least as accurate: set `ROUTER_MODEL=waypoint-router:manual` in `.env`.

## Moving a trained router

A finished run can be exported on the page as a package (a tar with `manifest.json`, SHA-256 per file):

- **Adapter** (tens of MB): only the LoRA weights. Importing it needs this Python environment and the same base model,
  which is downloaded from Hugging Face when the adapter is merged.
- **GGUF** (hundreds of MB): the adapter and the model ready for Ollama; it is created in Ollama right away.

"Import a model" accepts only such packages: fixed file names, safetensors and GGUF weights (no pickled checkpoints),
matching checksums, and a supported base model.

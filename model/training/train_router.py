"""Fine-tunes a small model as WaypointAI's router with LoRA.

Reads chat examples (JSON Lines: {"messages": [system, user, assistant]}) exported by the backend, trains a LoRA
adapter on the assistant turn only (the router's JSON answer), merges it into the base model, and saves the merged
model as safetensors for `ollama create`. Progress is printed as one JSON object per line, which the backend reads.

    python train_router.py --data data.jsonl --out runs/abc --base Qwen/Qwen3-0.6B --epochs 2
"""

import argparse
import json
import math
import random
import sys
import time


def emit(event: str, **fields) -> None:
    print(json.dumps({"event": event, **fields}), flush=True)


def peak_memory_mb() -> int | None:
    """Peak resident memory of this process (Linux reports kilobytes), shown beside the training progress."""
    try:
        import resource
        return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024)
    except Exception:
        return None


def pick_device(torch) -> str:
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch, "xpu") and torch.xpu.is_available():
        return "xpu"
    return "cpu"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--base", default="Qwen/Qwen3-0.6B")
    parser.add_argument("--epochs", type=float, default=2.0)
    parser.add_argument("--learning-rate", type=float, default=2e-4)
    parser.add_argument("--rank", type=int, default=16)
    parser.add_argument("--batch-size", type=int, default=8, help="examples per optimizer step")
    parser.add_argument("--micro-batch", type=int, default=2, help="examples per forward pass; gradients accumulate up to --batch-size")
    parser.add_argument("--max-examples", type=int, default=0)
    parser.add_argument("--holdout", type=float, default=0.05)
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()

    emit("status", phase="loading")
    import torch
    from peft import LoraConfig, get_peft_model
    from transformers import AutoModelForCausalLM, AutoTokenizer

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    device = pick_device(torch)
    emit("status", phase="loading", device=device, base=args.base)

    with open(args.data, encoding="utf-8") as handle:
        rows = [json.loads(line) for line in handle if line.strip()]
    random.shuffle(rows)
    if args.max_examples:
        rows = rows[: args.max_examples]
    holdout = max(1, int(len(rows) * args.holdout))
    validation, training = rows[:holdout], rows[holdout:]

    tokenizer = AutoTokenizer.from_pretrained(args.base)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    def encode(row):
        """Tokens of the whole chat; the loss covers only the assistant's answer."""
        messages = row["messages"]
        prompt = tokenizer.apply_chat_template(messages[:-1], tokenize=False, add_generation_prompt=True, enable_thinking=False)
        answer = messages[-1]["content"] + tokenizer.eos_token
        prompt_ids = tokenizer(prompt, add_special_tokens=False)["input_ids"]
        answer_ids = tokenizer(answer, add_special_tokens=False)["input_ids"]
        return {"input_ids": prompt_ids + answer_ids, "labels": [-100] * len(prompt_ids) + answer_ids}

    train_items = [encode(row) for row in training]
    valid_items = [encode(row) for row in validation]
    emit("status", phase="tokenized", train=len(train_items), validation=len(valid_items), max_tokens=max(len(item["input_ids"]) for item in train_items))

    dtype = torch.bfloat16 if device in ("cuda", "xpu") else torch.float32
    model = AutoModelForCausalLM.from_pretrained(args.base, torch_dtype=dtype).to(device)
    # Activations are recomputed in the backward pass instead of kept for all layers: much less memory, a bit slower.
    model.config.use_cache = False
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.enable_input_require_grads()
    model = get_peft_model(model, LoraConfig(
        r=args.rank, lora_alpha=args.rank * 2, lora_dropout=0.05, task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    ))
    trainable = sum(parameter.numel() for parameter in model.parameters() if parameter.requires_grad)
    emit("status", phase="training", trainable_parameters=trainable)

    def batches(items, size, shuffle):
        """Left-padded batches: every answer ends at the last position, so logits are needed only for the tail."""
        order = list(range(len(items)))
        if shuffle:
            random.shuffle(order)
        for start in range(0, len(order), size):
            chunk = [items[index] for index in order[start:start + size]]
            width = max(len(item["input_ids"]) for item in chunk)
            ids = torch.full((len(chunk), width), tokenizer.pad_token_id)
            labels = torch.full((len(chunk), width), -100)
            mask = torch.zeros((len(chunk), width), dtype=torch.long)
            for row, item in enumerate(chunk):
                length = len(item["input_ids"])
                ids[row, width - length:] = torch.tensor(item["input_ids"])
                labels[row, width - length:] = torch.tensor(item["labels"])
                mask[row, width - length:] = 1
            yield ids.to(device), labels.to(device), mask.to(device)

    def answer_loss(ids, labels, mask):
        """Cross-entropy on the answer tokens only. Logits over the whole vocabulary (~150k) are computed just for the
        answer's positions, not for the few hundred prompt tokens: that is what kept the memory of a step small."""
        answer = int((labels != -100).sum(dim=1).max())
        positions = (mask.cumsum(dim=1) - 1).clamp(min=0)
        logits = model(input_ids=ids, attention_mask=mask, position_ids=positions, logits_to_keep=answer + 1).logits[:, :-1]
        targets = labels[:, -answer:]
        return torch.nn.functional.cross_entropy(logits.float().reshape(-1, logits.size(-1)), targets.reshape(-1), ignore_index=-100)

    optimizer = torch.optim.AdamW([parameter for parameter in model.parameters() if parameter.requires_grad], lr=args.learning_rate)
    steps_per_epoch = math.ceil(len(train_items) / args.batch_size)
    total_steps = max(1, int(steps_per_epoch * args.epochs))
    scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, lambda step: min(1.0, (step + 1) / 10) * max(0.0, 1 - step / total_steps))

    def validate() -> float:
        model.eval()
        losses = []
        with torch.no_grad():
            for ids, labels, mask in batches(valid_items, args.micro_batch, False):
                losses.append(answer_loss(ids, labels, mask).item())
        model.train()
        return sum(losses) / max(1, len(losses))

    model.train()
    step = 0
    started = time.time()
    emit("progress", step=0, total=total_steps, epoch=0, loss=None, validation_loss=validate(), eta_seconds=None, peak_memory_mb=peak_memory_mb())
    while step < total_steps:
        micro = list(batches(train_items, args.micro_batch, True))
        accumulate = max(1, args.batch_size // args.micro_batch)
        for first in range(0, len(micro), accumulate):
            group = micro[first:first + accumulate]
            total_loss = 0.0
            for ids, labels, mask in group:
                loss = answer_loss(ids, labels, mask) / len(group)
                loss.backward()
                total_loss += loss.item()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            scheduler.step()
            optimizer.zero_grad()
            step += 1
            elapsed = time.time() - started
            last = step == total_steps or step % max(1, steps_per_epoch // 2) == 0
            emit("progress", step=step, total=total_steps, epoch=round(step / steps_per_epoch, 2), loss=round(total_loss, 4),
                 validation_loss=round(validate(), 4) if last else None, eta_seconds=round(elapsed / step * (total_steps - step)),
                 peak_memory_mb=peak_memory_mb())
            if step >= total_steps:
                break

    emit("status", phase="saving")
    model.save_pretrained(f"{args.out}/adapter")
    merged = model.merge_and_unload()
    merged.save_pretrained(f"{args.out}/merged", safe_serialization=True)
    tokenizer.save_pretrained(f"{args.out}/merged")
    emit("done", adapter=f"{args.out}/adapter", merged=f"{args.out}/merged", seconds=round(time.time() - started))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:  # Reported to the backend as one line; the traceback goes to stderr.
        import traceback
        traceback.print_exc()
        emit("error", message=str(error)[:300])
        sys.exit(1)

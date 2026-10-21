import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";

/**
 * A trained router as one file to move between machines: a plain tar archive with a manifest (the run's settings and
 * the SHA-256 of every file), the LoRA adapter, and, for the "gguf" kind, the model ready for Ollama. Reading accepts
 * only regular files under fixed names and sizes and writes them to fixed paths, so an archive can neither place a
 * file elsewhere nor bring a link, a script, or a pickled checkpoint. Weights are safetensors and GGUF only.
 */
export type PackageKind = "adapter" | "gguf";

export const PACKAGE_FILES = {
  manifest: "manifest.json",
  adapterConfig: "adapter/adapter_config.json",
  adapterWeights: "adapter/adapter_model.safetensors",
  gguf: "router-q8_0.gguf",
} as const;
type PackagePath = typeof PACKAGE_FILES[keyof typeof PACKAGE_FILES];

const MAX_SIZE: Record<PackagePath, number> = {
  "manifest.json": 1024 * 1024,
  "adapter/adapter_config.json": 64 * 1024,
  "adapter/adapter_model.safetensors": 1024 ** 3,
  "router-q8_0.gguf": 6 * 1024 ** 3,
};
const BLOCK = 512;

/** Base models an imported adapter may be for; the same list as for training. */
const ADAPTER_MODULES = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"];

const manifestSchema = z.object({
  format: z.literal("waypoint-router-package"),
  version: z.literal(1),
  kind: z.enum(["adapter", "gguf"]),
  exportedAt: z.string().max(40),
  run: z.object({
    id: z.string().regex(/^\d{8}-[0-9a-f]{6}$/),
    baseModel: z.string().max(80),
    epochs: z.number().min(0).max(100),
    learningRate: z.number().min(0).max(1),
    rank: z.number().int().min(1).max(256),
    examples: z.number().int().min(0).nullable(),
    device: z.string().max(20).nullable(),
    losses: z.array(z.object({ step: z.number(), loss: z.number().nullable(), validationLoss: z.number().nullable() })).max(5000),
    startedAt: z.string().max(40),
    finishedAt: z.string().max(40).nullable(),
  }),
  files: z.array(z.object({ path: z.enum(Object.values(PACKAGE_FILES) as [PackagePath, ...PackagePath[]]), size: z.number().int().min(0), sha256: z.string().regex(/^[0-9a-f]{64}$/) })).max(4),
});
export type PackageManifest = z.infer<typeof manifestSchema>;

export class PackageError extends Error {
  constructor(readonly code: "not_a_package" | "unexpected_entry" | "too_large" | "checksum_mismatch" | "unsupported_base_model" | "invalid_weights" | "missing_file") { super(code); }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** A ustar header for one regular file. */
function header(name: string, size: number): Buffer {
  const block = Buffer.alloc(BLOCK, 0);
  const field = (value: string, offset: number, length: number) => block.write(value, offset, length, "utf8");
  field(name, 0, 100);
  field("0000644\0", 100, 8);
  field("0000000\0", 108, 8);
  field("0000000\0", 116, 8);
  field(`${size.toString(8).padStart(11, "0")}\0`, 124, 12);
  field(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")}\0`, 136, 12);
  field("        ", 148, 8);
  field("0", 156, 1);
  field("ustar\0", 257, 6);
  field("00", 263, 2);
  let sum = 0;
  for (const byte of block) sum += byte;
  field(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return block;
}

const write = (output: Writable, chunk: Buffer) => new Promise<void>((resolve, reject) => output.write(chunk, (error) => (error ? reject(error) : resolve())));

/** Writes the package of a run folder to the stream; the caller ends the stream. */
export async function writePackage(folder: string, run: PackageManifest["run"], kind: PackageKind, output: Writable): Promise<void> {
  const paths: PackagePath[] = [PACKAGE_FILES.adapterConfig, PACKAGE_FILES.adapterWeights, ...(kind === "gguf" ? [PACKAGE_FILES.gguf] : [])];
  const files = await Promise.all(paths.map(async (path) => ({ path, size: (await stat(join(folder, path))).size, sha256: await sha256(join(folder, path)) })));
  const manifest: PackageManifest = { format: "waypoint-router-package", version: 1, kind, exportedAt: new Date().toISOString(), run, files };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 1));
  const padding = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK, 0);
  await write(output, header(PACKAGE_FILES.manifest, manifestBytes.length));
  await write(output, Buffer.concat([manifestBytes, padding(manifestBytes.length)]));
  for (const file of files) {
    await write(output, header(file.path, file.size));
    await pipeline(createReadStream(join(folder, file.path)), output, { end: false });
    await write(output, padding(file.size));
  }
  await write(output, Buffer.alloc(BLOCK * 2, 0));
}

function parseOctal(field: Buffer, isSize = false): number {
  // Base-256 numbers (first byte 0x80) are sizes over 8 GB, which no package has; elsewhere the block is not a header.
  if (field[0]! & 0x80) throw new PackageError(isSize ? "too_large" : "not_a_package");
  const text = field.toString("ascii").replace(/\0.*$/s, "").trim();
  if (!/^[0-7]*$/.test(text)) throw new PackageError("not_a_package");
  return text ? Number.parseInt(text, 8) : 0;
}

/**
 * Reads a package into the (new, empty) run folder and checks it: entries, sizes, checksums, the adapter's base model
 * and settings, and the weight file headers. Throws PackageError on anything unexpected; the caller removes the folder.
 */
export async function readPackage(archive: string, folder: string, allowedBaseModels: readonly string[]): Promise<PackageManifest> {
  const handle = await open(archive, "r");
  const found = new Map<PackagePath, { size: number; sha256: string }>();
  try {
    const total = (await handle.stat()).size;
    let offset = 0;
    const block = Buffer.alloc(BLOCK);
    while (offset + BLOCK <= total) {
      await handle.read(block, 0, BLOCK, offset);
      if (block.every((byte) => byte === 0)) break;
      let sum = 0;
      for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 32 : block[index]!;
      if (sum !== parseOctal(block.subarray(148, 156))) throw new PackageError("not_a_package");
      const prefix = block.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
      const name = `${prefix ? `${prefix}/` : ""}${block.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "")}`.replace(/^\.\//, "");
      const type = String.fromCharCode(block[156]!);
      const size = parseOctal(block.subarray(124, 136), true);
      offset += BLOCK;
      // Folders are implied by the fixed paths; anything else that is not a regular file is refused.
      if (type === "5" && name === "adapter/") continue;
      if (type !== "0" && type !== "\0") throw new PackageError("unexpected_entry");
      if (!(name in MAX_SIZE) || found.has(name as PackagePath)) throw new PackageError("unexpected_entry");
      const path = name as PackagePath;
      if (size > MAX_SIZE[path] || offset + size > total) throw new PackageError("too_large");
      const target = join(folder, path);
      await mkdir(dirname(target), { recursive: true });
      const hash = createHash("sha256");
      if (size > 0) {
        const source = createReadStream(archive, { start: offset, end: offset + size - 1 });
        source.on("data", (chunk) => hash.update(chunk as Buffer));
        await pipeline(source, createWriteStream(target, { flags: "wx" }));
      } else {
        await writeFile(target, "", { flag: "wx" });
      }
      found.set(path, { size, sha256: hash.digest("hex") });
      offset += Math.ceil(size / BLOCK) * BLOCK;
    }
  } finally {
    await handle.close();
  }

  if (!found.has(PACKAGE_FILES.manifest)) throw new PackageError("not_a_package");
  let manifest: PackageManifest;
  try { manifest = manifestSchema.parse(JSON.parse(await readFile(join(folder, PACKAGE_FILES.manifest), "utf8"))); } catch { throw new PackageError("not_a_package"); }
  const expected: PackagePath[] = [PACKAGE_FILES.adapterConfig, PACKAGE_FILES.adapterWeights, ...(manifest.kind === "gguf" ? [PACKAGE_FILES.gguf] : [])];
  for (const path of expected) {
    const listed = manifest.files.find((file) => file.path === path);
    const actual = found.get(path);
    if (!listed || !actual) throw new PackageError("missing_file");
    if (listed.size !== actual.size || listed.sha256 !== actual.sha256) throw new PackageError("checksum_mismatch");
  }
  if ([...found.keys()].some((path) => path !== PACKAGE_FILES.manifest && !expected.includes(path))) throw new PackageError("unexpected_entry");
  if (!allowedBaseModels.includes(manifest.run.baseModel)) throw new PackageError("unsupported_base_model");
  await checkAdapterConfig(join(folder, PACKAGE_FILES.adapterConfig), manifest.run.baseModel);
  await checkSafetensors(join(folder, PACKAGE_FILES.adapterWeights));
  if (manifest.kind === "gguf") await checkGguf(join(folder, PACKAGE_FILES.gguf));
  return manifest;
}

/** A LoRA config for the stated base model, over the modules training uses; nothing that loads code. */
async function checkAdapterConfig(path: string, baseModel: string): Promise<void> {
  let config: Record<string, unknown>;
  try { config = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>; } catch { throw new PackageError("invalid_weights"); }
  const modules = config.target_modules;
  const valid = config.peft_type === "LORA"
    && config.base_model_name_or_path === baseModel
    && typeof config.r === "number" && Number.isInteger(config.r) && config.r >= 1 && config.r <= 256
    && Array.isArray(modules) && modules.length > 0 && modules.every((module) => ADAPTER_MODULES.includes(module as string))
    && (config.auto_mapping === null || config.auto_mapping === undefined)
    && (config.modules_to_save === null || config.modules_to_save === undefined);
  if (!valid) throw new PackageError(config.base_model_name_or_path === baseModel ? "invalid_weights" : "unsupported_base_model");
}

/** safetensors: an 8-byte little-endian header length, then that many bytes of JSON describing the tensors. */
async function checkSafetensors(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size;
    const prefix = Buffer.alloc(8);
    await handle.read(prefix, 0, 8, 0);
    const length = Number(prefix.readBigUInt64LE(0));
    if (length <= 0 || length > 100 * 1024 * 1024 || length + 8 > size) throw new PackageError("invalid_weights");
    const json = Buffer.alloc(length);
    await handle.read(json, 0, length, 8);
    const parsed = JSON.parse(json.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new PackageError("invalid_weights");
  } catch (error) {
    throw error instanceof PackageError ? error : new PackageError("invalid_weights");
  } finally {
    await handle.close();
  }
}

async function checkGguf(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    const magic = Buffer.alloc(4);
    await handle.read(magic, 0, 4, 0);
    if (magic.toString("ascii") !== "GGUF") throw new PackageError("invalid_weights");
  } finally {
    await handle.close();
  }
}

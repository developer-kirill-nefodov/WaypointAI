import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Start the development environment with `npm run dev`.");

for (const args of [["run", "contracts:types"], ["run", "build", "-w", "@waypoint-ai/shared"]]) {
  const result = spawnSync(process.execPath, [npmCli, ...args], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const children = ["@waypoint-ai/backend", "@waypoint-ai/frontend"].map((workspace) => spawn(
  process.execPath,
  [npmCli, "run", "dev", "--workspace", workspace],
  { cwd: root, stdio: "inherit", env: process.env },
));

let stopping = false;
function stopAll(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (!child.killed) child.kill(signal);
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stopAll(signal));
for (const child of children) child.on("exit", (code) => {
  if (!stopping) stopAll();
  process.exitCode = code ?? 1;
});

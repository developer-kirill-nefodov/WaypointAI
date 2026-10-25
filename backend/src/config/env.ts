import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { modelEnvironmentSchema } from "./model.js";
import { voiceEnvironmentSchema } from "./voice.js";
import { eventsEnvironmentSchema } from "./events.js";
import { osmEnvironmentSchema } from "./osm.js";
import { teacherEnvironmentSchema } from "./teacher.js";

// Load the repository-root .env regardless of the working directory; workspace scripts run from backend/.
// Resolves to the root from both src/config/ and dist/config/.
loadDotenv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8000),
  FRONTEND_ORIGIN: z.string().url().default("http://127.0.0.1:5173"),
  DATABASE_URL: z.string().default("postgres://waypoint:waypoint_dev@127.0.0.1:5433/waypoint"),
  ROUTING_BASE_URL: z.string().url().default("https://router.project-osrm.org"),
  // Express "trust proxy": false (default, direct connections) or a hop count when behind a reverse proxy.
  // Never "true": that would trust any client-supplied X-Forwarded-For and defeat per-client rate limits.
  TRUST_PROXY: z.preprocess((value) => value === undefined || value === "" || value === "false" ? false : Number(value), z.union([z.literal(false), z.number().int().min(1).max(5)])),
  DEMO_MODE: z.preprocess((value) => value === undefined ? "true" : value, z.enum(["true", "false"]).transform((value) => value === "true")),
  // Editing lessons and running the exam changes what every user's assistant is told; there is no authentication, so
  // it is on by default only in development.
  // The journal of chat turns: kept on this machine, deleted after JOURNAL_RETENTION_DAYS.
  // A model that picks the first tool call from the short router prompt (for example a fine-tuned small model);
  // unset uses the full prompt with OLLAMA_MODEL.
  ROUTER_MODEL: z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).max(120).optional()),
  JOURNAL_ENABLED: z.preprocess((value) => value === undefined || value === "" ? "true" : value, z.enum(["true", "false"]).transform((value) => value === "true")),
  JOURNAL_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  // Follow-up suggestions come with the answer, built by the server from the turn. With true, the local model also
  // writes its own after the answer (about 20 s on a laptop) and they replace the server's.
  FOLLOW_UPS_MODEL: z.preprocess((value) => value === undefined || value === "" ? "false" : value, z.enum(["true", "false"]).transform((value) => value === "true")),
  TRAINING_ENABLED: z.preprocess((value) => value === "" ? undefined : value, z.enum(["true", "false"]).transform((value) => value === "true").optional()),
}).merge(modelEnvironmentSchema).merge(voiceEnvironmentSchema).merge(eventsEnvironmentSchema).merge(osmEnvironmentSchema).merge(teacherEnvironmentSchema);

export const env = envSchema.parse(process.env);

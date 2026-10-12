import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { modelEnvironmentSchema } from "./model.js";
import { voiceEnvironmentSchema } from "./voice.js";
import { eventsEnvironmentSchema } from "./events.js";

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
}).merge(modelEnvironmentSchema).merge(voiceEnvironmentSchema).merge(eventsEnvironmentSchema);

export const env = envSchema.parse(process.env);

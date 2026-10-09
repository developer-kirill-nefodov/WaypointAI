import "dotenv/config";
import { z } from "zod";
import { modelEnvironmentSchema } from "./model.js";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8000),
  FRONTEND_ORIGIN: z.string().url().default("http://127.0.0.1:5173"),
  DATABASE_URL: z.string().default("postgres://waypoint:waypoint_dev@127.0.0.1:5433/waypoint"),
  ROUTING_BASE_URL: z.string().url().default("https://router.project-osrm.org"),
  DEMO_MODE: z.preprocess((value) => value === undefined ? "true" : value, z.enum(["true", "false"]).transform((value) => value === "true")),
}).merge(modelEnvironmentSchema);

export const env = envSchema.parse(process.env);

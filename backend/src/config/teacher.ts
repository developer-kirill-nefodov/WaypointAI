import { z } from "zod";

/**
 * The teacher: an OpenAI model that writes training examples for the router (Model page → Fine-tuning). It reuses
 * OPENAI_API_KEY, which stays on the backend. Only synthetic prompts are sent: topic instructions and settlement
 * names from the OSM import, never journal turns.
 */
export const teacherEnvironmentSchema = z.object({
  TEACHER_MODEL: z.string().regex(/^[a-zA-Z0-9._:-]{1,80}$/).default("gpt-4.1-mini"),
  // Examples the teacher may write per day (UTC), counting every requested example: a ceiling on spending.
  TEACHER_MAX_EXAMPLES_PER_DAY: z.coerce.number().int().min(10).max(50_000).default(2000),
});

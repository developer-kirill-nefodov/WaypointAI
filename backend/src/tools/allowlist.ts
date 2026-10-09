import type { ToolName } from "@waypoint-ai/shared";

/** Model-callable tools; each tool is read-only and implemented by backend services. */
export const ALLOWED_TOOLS = ["search_records", "get_record_details", "search_places", "list_sources"] as const satisfies readonly ToolName[];

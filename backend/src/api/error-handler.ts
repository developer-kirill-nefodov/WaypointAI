import type { ErrorRequestHandler } from "express";

/** Last-resort error handler: client body errors get 4xx codes; everything else is a generic 500 without details. */
export const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  // Body-parser errors are client errors, not server faults.
  const type = error && typeof error === "object" && "type" in error ? String(error.type) : "";
  if (type === "entity.parse.failed") {
    response.status(400).json({ error: "invalid_json" });
    return;
  }
  if (type === "entity.too.large") {
    response.status(413).json({ error: "payload_too_large" });
    return;
  }
  console.error("Unhandled request error", error);
  response.status(500).json({ error: "internal_error" });
};

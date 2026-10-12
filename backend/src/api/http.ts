import { Router } from "express";
import { z } from "zod";
import { getSources, searchPlaces } from "../data/record.repository.js";
import { listSources } from "../data/source.repository.js";
import { clearConversationHistory } from "../data/conversation.repository.js";
import { getCapabilities } from "../services/readiness.js";
import { isValidBbox } from "../services/geometry.js";
import { env } from "../config/env.js";
import { toPointFeatureCollection } from "./geojson.js";

export const apiRouter = Router();

const routePointSchema = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).strict();
const routeRequestSchema = z.object({ points: z.array(routePointSchema).min(2).max(8) }).strict();

apiRouter.post("/map/route", async (request, response) => {
  const parsed = routeRequestSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: "invalid_route_request" });
  const routeStartedAt = performance.now();
  let routeOutcome: "completed" | "unavailable" = "unavailable";

  const coordinates = parsed.data.points.map(({ lon, lat }) => `${lon},${lat}`).join(";");
  const endpoint = `${env.ROUTING_BASE_URL.replace(/\/$/, "")}/trip/v1/driving/${coordinates}`;
  const url = new URL(endpoint);
  url.searchParams.set("roundtrip", "false");
  url.searchParams.set("source", "first");
  url.searchParams.set("destination", "last");
  url.searchParams.set("geometries", "geojson");
  url.searchParams.set("overview", "full");
  url.searchParams.set("steps", "false");

  try {
    const upstream = await fetch(url, { signal: AbortSignal.timeout(12_000), headers: { accept: "application/json" } });
    if (!upstream.ok) return response.status(502).json({ error: "route_unavailable" });
    const payload = await upstream.json() as {
      code?: string;
      trips?: Array<{ distance?: number; duration?: number; geometry?: { type?: string; coordinates?: number[][] } }>;
      waypoints?: Array<{ waypoint_index?: number }>;
    };
    const trip = payload.trips?.[0];
    const coordinatesResult = trip?.geometry?.coordinates;
    if (payload.code !== "Ok" || !trip || !Number.isFinite(trip.distance) || !Number.isFinite(trip.duration) || !coordinatesResult?.length || !payload.waypoints || payload.waypoints.length !== parsed.data.points.length) {
      return response.status(502).json({ error: "route_unavailable" });
    }
    const order = payload.waypoints
      .map((waypoint, inputIndex) => ({ inputIndex, waypointIndex: waypoint.waypoint_index }))
      .filter((waypoint): waypoint is { inputIndex: number; waypointIndex: number } => Number.isInteger(waypoint.waypointIndex))
      .sort((left, right) => left.waypointIndex - right.waypointIndex)
      .map((waypoint) => waypoint.inputIndex);
    if (order.length !== parsed.data.points.length || new Set(order).size !== order.length || order.some((index) => index < 0 || index >= parsed.data.points.length) || coordinatesResult.some((point) => point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1]))) {
      return response.status(502).json({ error: "route_unavailable" });
    }
    routeOutcome = "completed";
    response.json({ distanceMeters: trip.distance, durationSeconds: trip.duration, order, geometry: { type: "LineString", coordinates: coordinatesResult } });
  } catch {
    response.status(502).json({ error: "route_unavailable" });
  } finally {
    console.info("Map route performance", {
      durationMs: Math.round(performance.now() - routeStartedAt),
      pointCount: parsed.data.points.length,
      provider: "osrm-compatible",
      outcome: routeOutcome,
    });
  }
});

apiRouter.get("/healthz", (_request, response) => response.json({ status: "ok", apiVersion: "v1" }));
apiRouter.get("/assistant/capabilities", async (_request, response, next) => {
  try { response.json(await getCapabilities()); } catch (error) { next(error); }
});
apiRouter.delete("/assistant/history", async (_request, response, next) => {
  try {
    await clearConversationHistory("demo");
    response.status(204).end();
  } catch (error) { next(error); }
});
apiRouter.get("/data/sources", async (_request, response, next) => {
  try { response.json({ sources: await listSources() }); } catch (error) { next(error); }
});
apiRouter.get("/data/places", async (request, response, next) => {
  const querySchema = z.object({
    q: z.string().trim().max(100).optional(),
    category: z.string().trim().max(120).optional(),
    city: z.string().trim().max(120).optional(),
    sourceIds: z.string().max(500).optional(),
    bbox: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }).strict();
  const parsed = querySchema.safeParse(request.query);
  if (!parsed.success) return response.status(400).json({ error: "invalid_query" });
  const bbox = parsed.data.bbox?.split(",").map(Number);
  if (bbox && !isValidBbox(bbox)) return response.status(400).json({ error: "invalid_bbox" });
  try {
    const result = await searchPlaces({
      query: parsed.data.q,
      category: parsed.data.category,
      city: parsed.data.city,
      sourceIds: parsed.data.sourceIds?.split(",").map((id) => id.trim()).filter(Boolean).slice(0, 20),
      bbox,
      limit: parsed.data.limit,
    });
    const sources = await getSources([...new Set(result.places.map((place) => place.sourceId))]);
    response.json({
      total: result.total,
      places: result.places,
      mapFeatures: toPointFeatureCollection(result.places, (place) => ({
        entityType: "place",
        id: place.id,
        sourceId: place.sourceId,
        label: place.name,
        category: place.category,
      })),
      sources,
    });
  } catch (error) { next(error); }
});

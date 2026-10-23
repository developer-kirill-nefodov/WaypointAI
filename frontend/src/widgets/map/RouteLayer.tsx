import { useEffect, useMemo } from "react";
import { divIcon, type LatLngExpression } from "leaflet";
import { Marker, Polyline, Tooltip } from "react-leaflet";
import { buildRoute, type RoutePlan } from "../../shared/api/client";

export type RoutePoint = { id: string; name: string; lat: number; lon: number; countryCode: string; city: string | null };
export type RouteState = { status: "idle" | "loading" | "ready" | "error"; plan: RoutePlan | null; orderedPoints: RoutePoint[] };

export default function RouteLayer({ points, retryKey, onState }: { points: RoutePoint[]; retryKey: number; onState: (state: RouteState) => void }) {
  const signature = points.map((point) => `${point.id}:${point.lat},${point.lon}`).join("|");
  const routePoints = useMemo(() => points.slice(0, 8), [signature]);

  useEffect(() => {
    if (routePoints.length < 2) {
      onState({ status: "idle", plan: null, orderedPoints: [] });
      return;
    }

    const controller = new AbortController();
    onState({ status: "loading", plan: null, orderedPoints: [] });
    buildRoute(routePoints.map(({ lat, lon }) => ({ lat, lon })), controller.signal)
      .then((plan) => {
        const orderedPoints = plan.order.map((index) => routePoints[index]).filter((point): point is RoutePoint => Boolean(point));
        if (orderedPoints.length !== routePoints.length) throw new Error("Invalid route order");
        onState({ status: "ready", plan, orderedPoints });
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) onState({ status: "error", plan: null, orderedPoints: [] });
      });
    return () => controller.abort();
  }, [signature, retryKey, onState]);

  return null;
}

/** The road route with its numbered stops; a click on a stop selects that place (the number lies over its marker). */
export function RouteGeometry({ plan, points, color = "#41cda0", onSelect }: { plan: RoutePlan | null; points: RoutePoint[]; color?: string; onSelect?: (id: string) => void }) {
  if (!plan || points.length < 2) return null;
  const positions = plan.geometry.coordinates.map(([lon, lat]) => [lat, lon] as LatLngExpression);
  return <>
    <Polyline positions={positions} pathOptions={{ color: "#081b2c", opacity: 0.88, weight: 9, lineCap: "round", lineJoin: "round" }} />
    <Polyline positions={positions} pathOptions={{ color, opacity: 0.96, weight: 5, lineCap: "round", lineJoin: "round" }} />
    {points.map((point, index) => <Marker key={`${point.id}:${index}`} position={[point.lat, point.lon]} icon={routeStopIcon(index + 1)} zIndexOffset={900} eventHandlers={onSelect ? { click: () => onSelect(point.id) } : undefined}>
      <Tooltip direction="top" offset={[0, -14]}>
        <span>{index + 1}. {point.name}</span>
      </Tooltip>
    </Marker>)}
  </>;
}

function routeStopIcon(number: number) {
  return divIcon({
    className: "route-stop-icon",
    html: `<span>${number}</span>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

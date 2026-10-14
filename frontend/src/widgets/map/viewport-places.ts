import type { PlaceView } from "@waypoint-ai/shared";

/** Places of the map area are loaded per fixed grid cell, so a cell's set never changes while the user pans. */
export const MIN_PLACES_ZOOM = 8;
/** A cell is about three 256 px tiles wide at its zoom, so a screen shows a handful of cells. */
const CELL_TILES = 3;
/** Per-cell cap; with a few cells on screen this keeps the canvas at roughly a thousand points. */
export const PLACES_PER_CELL = 250;
const MAX_CACHED_CELLS = 300;

export interface Cell { key: string; bbox: [number, number, number, number] }
export interface CellResult { total: number; places: PlaceView[] }
type Bounds = { west: number; south: number; east: number; north: number };

export function cellSizeDegrees(zoom: number): number {
  return (360 / 2 ** Math.round(zoom)) * CELL_TILES;
}

/** Cells covering the bounds, nearest to the center first so the visible middle fills in before the edges. */
export function cellsForBounds(bounds: Bounds, zoom: number, scope: string): Cell[] {
  const size = cellSizeDegrees(zoom);
  const z = Math.round(zoom);
  const cells: Array<Cell & { distance: number }> = [];
  const centerX = (bounds.west + bounds.east) / 2 / size;
  const centerY = (bounds.south + bounds.north) / 2 / size;
  for (let x = Math.floor(bounds.west / size); x <= Math.floor(bounds.east / size); x += 1) {
    for (let y = Math.floor(bounds.south / size); y <= Math.floor(bounds.north / size); y += 1) {
      const west = Math.max(-180, x * size);
      const south = Math.max(-90, y * size);
      const east = Math.min(180, (x + 1) * size);
      const north = Math.min(90, (y + 1) * size);
      if (west >= east || south >= north) continue;
      cells.push({ key: `${scope}|${z}|${x}|${y}`, bbox: [west, south, east, north], distance: Math.hypot(x + 0.5 - centerX, y + 0.5 - centerY) });
    }
  }
  return cells.sort((left, right) => left.distance - right.distance).map(({ key, bbox }) => ({ key, bbox }));
}

/** Least-recently-used cache of cell results; reading a cell marks it as used. */
export class CellCache {
  readonly #entries = new Map<string, CellResult>();
  constructor(private readonly limit = MAX_CACHED_CELLS) {}

  get(key: string): CellResult | undefined {
    const value = this.#entries.get(key);
    if (value) {
      this.#entries.delete(key);
      this.#entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: CellResult): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    while (this.#entries.size > this.limit) this.#entries.delete(this.#entries.keys().next().value!);
  }
}

/** Places of the given cells that are cached, without duplicates, and the sum of their totals. */
export function collectCells(cells: Cell[], cache: CellCache): CellResult {
  const places = new Map<string, PlaceView>();
  let total = 0;
  for (const cell of cells) {
    const result = cache.get(cell.key);
    if (!result) continue;
    total += result.total;
    for (const place of result.places) places.set(place.id, place);
  }
  return { total, places: [...places.values()] };
}

import { wktToGeoJSON, geojsonToWKT } from '@terraformer/wkt'
import sweeplineIntersections from 'sweepline-intersections'
import polygonClipping from 'polygon-clipping'

// Coordinates are rounded to ~11 cm: ES' tessellator works at ~1e-6° and the extra decimals only
// inflate the raw column (stored in `_source`), `_geoshape` and the tiles payloads.
export const COORD_DECIMALS = 6
const FACTOR = 10 ** COORD_DECIMALS
const SRID_RE = /^SRID=\d+;/

// 1.5.x ships an ESM-style d.ts for a UMD build whose module.exports IS the function
const findIntersections = sweeplineIntersections as unknown as typeof sweeplineIntersections.default

type Position = number[]
interface Geometry { type: string, coordinates?: any }

const roundValue = (value: number): number => Math.round(value * FACTOR) / FACTOR

const roundCoordinates = (coordinates: any): any =>
  Array.isArray(coordinates[0]) ? coordinates.map(roundCoordinates) : coordinates.map(roundValue)

const roundGeometry = (geometry: Geometry): Geometry => ({
  type: geometry.type,
  coordinates: roundCoordinates(geometry.coordinates)
})

const samePosition = (a: Position, b: Position): boolean => a[0] === b[0] && a[1] === b[1]

/**
 * Drop consecutive duplicate points and close the ring. Returns null when fewer than 3 distinct
 * points remain: ES refuses to tessellate such a ring ("malformed shape"), and data-fair's own
 * repair (@turf/unkink-polygon) leaves it untouched.
 */
const cleanRing = (ring: Position[]): Position[] | null => {
  const out: Position[] = []
  for (const position of ring) {
    if (!out.length || !samePosition(out[out.length - 1], position)) out.push(position)
  }
  if (out.length && !samePosition(out[0], out[out.length - 1])) out.push(out[0])
  return out.length >= 4 ? out : null
}

const cleanPolygon = (coordinates: Position[][]): Position[][] | null => {
  const rings = coordinates.map(cleanRing).filter((ring): ring is Position[] => ring !== null)
  return rings.length ? rings : null
}

/** Remove rings/polygons a rounding pass may have collapsed; null when nothing valid is left. */
const cleanGeometry = (geometry: Geometry): Geometry | null => {
  if (geometry.type === 'Polygon') {
    const coordinates = cleanPolygon(geometry.coordinates)
    return coordinates ? { type: 'Polygon', coordinates } : null
  }
  if (geometry.type === 'MultiPolygon') {
    const polygons = geometry.coordinates
      .map(cleanPolygon)
      .filter((polygon): polygon is Position[][] => polygon !== null)
    if (!polygons.length) return null
    return polygons.length === 1
      ? { type: 'Polygon', coordinates: polygons[0] }
      : { type: 'MultiPolygon', coordinates: polygons }
  }
  return geometry
}

const selfIntersects = (geometry: Geometry): boolean => {
  if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') return false
  try {
    return findIntersections({ type: 'Feature', geometry, properties: {} }, false).length > 0
  } catch {
    return true
  }
}

/**
 * Resolve self-intersections the way ES' tessellator cannot. `union(polygon, polygon)` is the JS
 * equivalent of GEOS `buffer(0)`: it splits a kinked ring into valid polygons. This is stronger
 * than data-fair's `@turf/unkink-polygon` fallback, which no-ops on the near-degenerate kinks RNB
 * contains. Returns null on failure.
 */
const makeValid = (geometry: Geometry): Geometry | null => {
  try {
    const multi = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
    const result = polygonClipping.union(multi as any, multi as any) as any
    if (!result.length) return null
    return result.length === 1
      ? { type: 'Polygon', coordinates: result[0] }
      : { type: 'MultiPolygon', coordinates: result }
  } catch {
    return null
  }
}

/**
 * EWKT/WKT → rounded, ES-indexable WKT. Returns '' when the geometry cannot be made valid, so the
 * line is still indexed (data-fair simply skips its geo fields) instead of being rejected with
 * "Unable to Tessellate shape".
 */
export const shapeToWkt = (value: string): string => {
  const wkt = (value || '').replace(SRID_RE, '')
  if (!wkt) return ''
  try {
    const geometry = wktToGeoJSON(wkt) as Geometry
    if (!geometry?.type || !geometry.coordinates) return ''
    if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') {
      return geojsonToWKT(roundGeometry(geometry) as any)
    }
    const rounded = roundGeometry(geometry)
    let cleaned = cleanGeometry(rounded)
    if (!cleaned) return ''
    if (selfIntersects(cleaned)) {
      cleaned = makeValid(cleaned)
      if (!cleaned) return ''
      cleaned = cleanGeometry(roundGeometry(cleaned))
      if (!cleaned) return ''
    }
    return geojsonToWKT(cleaned as any)
  } catch {
    return ''
  }
}

import { wktToGeoJSON, geojsonToWKT } from '@terraformer/wkt'
import polygonClipping from 'polygon-clipping'
import sweeplineIntersections from 'sweepline-intersections'

// Coordinates are rounded to ~11 cm: ES' tessellator works at ~1e-6° and the extra decimals only
// inflate the raw column (stored in `_source`), `_geoshape` and the tiles payloads.
export const COORD_DECIMALS = 6
const FACTOR = 10 ** COORD_DECIMALS
const SRID_RE = /^SRID=\d+;/

// 1.5.x ships an ESM-style d.ts for a UMD build whose module.exports IS the function
const findIntersections = sweeplineIntersections as unknown as typeof sweeplineIntersections.default

// Above this many points in a polygon the exact O(n²) test is skipped and the geometry is repaired
// unconditionally. RNB buildings are far below; the rare huge shapes are worth one union.
const EXACT_CHECK_MAX_POINTS = 1000

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

// A ring whose absolute area is below this (~0.1 m²) is noise: rounding kinks and the
// polygon-clipping split manufacture such slivers (RNB 38H384R45P5A ends up as an 11 cm wide
// triangle), and the ES tessellator is needlessly fragile on them.
const MIN_RING_AREA = 1e-11

/** Shoelace signed area of a closed ring. */
const ringArea = (ring: Position[]): number => {
  let area = 0
  for (let i = 0; i < ring.length - 1; i++) {
    area += cross(ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1])
  }
  return area / 2
}

/** Ray casting: is `point` inside `ring`? ES drops the whole line when a hole escapes its shell. */
const pointInRing = (point: Position, ring: Position[]): boolean => {
  let inside = false
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    if ((ring[i][1] > point[1]) !== (ring[j][1] > point[1]) &&
      point[0] < ((ring[j][0] - ring[i][0]) * (point[1] - ring[i][1])) / (ring[j][1] - ring[i][1]) + ring[i][0]) {
      inside = !inside
    }
  }
  return inside
}

/**
 * Clean a polygon: the first ring is the shell (the whole polygon is dropped when degenerate), the
 * following ones are holes. Holes that collapsed, are negligible or escape the shell are dropped:
 * ES refuses our ring as an "illegal hole" and rejects the whole line with it.
 */
const cleanPolygon = (coordinates: Position[][]): Position[][] | null => {
  const shell = cleanRing(coordinates[0] ?? [])
  if (!shell || Math.abs(ringArea(shell)) < MIN_RING_AREA) return null
  const rings = [shell]
  for (const hole of coordinates.slice(1)) {
    const cleaned = cleanRing(hole)
    if (cleaned && Math.abs(ringArea(cleaned)) >= MIN_RING_AREA && pointInRing(cleaned[0], shell)) rings.push(cleaned)
  }
  return rings
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

const cross = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx

const orientation = (a: Position, b: Position, c: Position): number =>
  cross(b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1])

const isOnSegment = (a: Position, b: Position, p: Position): boolean =>
  Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) &&
  Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1])

const samePoint = (a: Position, b: Position): boolean => a[0] === b[0] && a[1] === b[1]

const isInteriorPoint = (a: Position, b: Position, p: Position): boolean =>
  !samePoint(p, a) && !samePoint(p, b) && orientation(a, b, p) === 0 && isOnSegment(a, b, p)

/**
 * Exact conflict test between two edges: proper crossing, T-junction, collinear overlap or
 * duplicated edge. A single shared endpoint is allowed (the two lobes of a split figure-eight touch
 * at the pinch point, which is a valid MultiPolygon).
 */
const edgesConflict = (a: Position, b: Position, c: Position, d: Position): boolean => {
  if (samePoint(a, c) && samePoint(b, d)) return true
  if (samePoint(a, d) && samePoint(b, c)) return true
  const o1 = orientation(a, b, c)
  const o2 = orientation(a, b, d)
  const o3 = orientation(c, d, a)
  const o4 = orientation(c, d, b)
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true
  if (isInteriorPoint(a, b, c) || isInteriorPoint(a, b, d)) return true
  if (isInteriorPoint(c, d, a) || isInteriorPoint(c, d, b)) return true
  return false
}

const polygonRings = (geometry: Geometry): Position[][] => {
  if (geometry.type === 'Polygon') return geometry.coordinates
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat()
  return []
}

const countPoints = (geometry: Geometry): number => {
  let total = 0
  for (const ring of polygonRings(geometry)) total += ring.length
  return total
}

/** A ring whose points are all exactly collinear has zero area: ES refuses to tessellate it. */
const allPointsCollinear = (ring: Position[]): boolean => {
  const n = ring.length - 1
  for (let i = 0; i < n; i++) {
    if (orientation(ring[(i + n - 1) % n], ring[i], ring[(i + 1) % n]) !== 0) return false
  }
  return true
}

/**
 * A ring ES always chokes on: a repeated (non consecutive) vertex — the shape rounding creates on
 * RNB ASKDP3ZF62M3/38H384R45P5A — or a fully degenerate ring. Redundant collinear points on a
 * straight edge are left alone: data-fair's cleanCoords drops them anyway.
 */
const ringIsSuspicious = (ring: Position[]): boolean => {
  const n = ring.length - 1
  const seen = new Set<string>()
  for (let i = 0; i < n; i++) {
    const key = `${ring[i][0]},${ring[i][1]}`
    if (seen.has(key)) return true
    seen.add(key)
  }
  return allPointsCollinear(ring)
}

/** Every pair of non-adjacent edges must be disjoint, including across rings and multipolygon parts. */
const edgesOverlap = (rings: Position[][]): boolean => {
  const edges: { a: Position, b: Position, ring: number, index: number, count: number }[] = []
  for (let r = 0; r < rings.length; r++) {
    const count = rings[r].length - 1
    for (let i = 0; i < count; i++) {
      edges.push({ a: rings[r][i], b: rings[r][i + 1], ring: r, index: i, count })
    }
  }
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const e1 = edges[i]
      const e2 = edges[j]
      if (e1.ring === e2.ring) {
        const gap = Math.abs(e1.index - e2.index)
        if (gap === 1 || gap === e1.count - 1) continue // adjacent edges share a vertex
      }
      if (edgesConflict(e1.a, e1.b, e2.a, e2.b)) return true
    }
  }
  return false
}

/** Exact validity test on already cleaned, rounded rings. */
const exactGeometryInvalid = (geometry: Geometry): boolean => {
  if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') return false
  const rings = polygonRings(geometry)
  for (const ring of rings) {
    if (ringIsSuspicious(ring)) return true
  }
  return edgesOverlap(rings)
}

/** sweepline-intersections, the detector the first releases used before the exact test replaced it. */
const selfIntersects = (geometry: Geometry): boolean => {
  try {
    return findIntersections({ type: 'Feature', geometry, properties: {} }, false).length > 0
  } catch {
    return true
  }
}

/**
 * Would the v1.0.2 pipeline have unioned this shape? It trusted sweepline-intersections, which
 * flags figures the exact test above tolerates (two polygons touching at a vertex, a hole touching
 * its shell, near-degenerate kinks). The polygon it then stored with polygon-clipping can still be
 * refused by Elasticsearch ("Unable to Tessellate shape"), and the repair pass, which only runs
 * the exact test, would leave it untouched. Returns true for those legacy shapes so the repair
 * pass rewrites them with today's geometry.
 */
export const legacyRepairNeeded = (value: string): boolean => {
  const wkt = (value || '').replace(SRID_RE, '')
  if (!wkt) return false
  try {
    const geometry = wktToGeoJSON(wkt) as Geometry
    if ((geometry?.type !== 'Polygon' && geometry?.type !== 'MultiPolygon') || !geometry.coordinates) return false
    const cleaned = cleanGeometry(roundGeometry(geometry))
    return cleaned ? selfIntersects(cleaned) : false
  } catch {
    return false
  }
}

/**
 * Reliable replacement for sweepline-intersections, which misses the near-degenerate kinks that
 * rounding creates (it reports no intersection for RNB ASKDP3ZF62M3 and 38H384R45P5A) and lets
 * Elasticsearch reject the whole line. The exact O(n²) test is only run on the small RNB rings;
 * above EXACT_CHECK_MAX_POINTS the geometry goes through the union regardless.
 */
const geometryNeedsRepair = (geometry: Geometry): boolean =>
  countPoints(geometry) > EXACT_CHECK_MAX_POINTS || exactGeometryInvalid(geometry)

/** Already closed, ≥ 4 points, no duplicate and not negligible: cleaning it would change it. */
const ringIsAcceptable = (ring: Position[]): boolean => {
  const cleaned = cleanRing(ring)
  return cleaned !== null && cleaned.length === ring.length && Math.abs(ringArea(cleaned)) >= MIN_RING_AREA
}

/**
 * Would Elasticsearch accept the shape exactly as the export wrote it? The first releases of this
 * plugin stored the raw WKT verbatim, so a line's stored shape may be unclosed, degenerate,
 * self-intersecting or carry an escaped hole even when our rounded output is valid (rounding heals
 * some kinks). The repair pass must rewrite those lines too: `repaired` is true for them as well.
 */
const rawGeometryEsSafe = (geometry: Geometry): boolean => {
  if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') return true
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
  let points = 0
  for (const polygon of polygons) {
    if (!polygon.length || !ringIsAcceptable(polygon[0])) return false
    points += polygon[0].length
    for (const hole of polygon.slice(1)) {
      if (!ringIsAcceptable(hole) || !pointInRing(hole[0], polygon[0])) return false
      points += hole.length
    }
  }
  if (points > EXACT_CHECK_MAX_POINTS) return false // play safe: rewrite the rare huge shapes
  return !exactGeometryInvalid(geometry)
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

export interface ShapeResult {
  /** Rounded, ES-indexable WKT. '' when the geometry cannot be made valid: the line is still indexed, data-fair simply skips its geo fields. */
  wkt: string
  /** True when the source needed a repair (rounding kink, self-intersection, degenerate ring, parse error). */
  repaired: boolean
}

/**
 * EWKT/WKT → rounded, ES-indexable WKT. `repaired` is true when the stored shape is not the
 * geometry the current pipeline would write (raw kink, self-intersection, degenerate ring, hole
 * escaped from its shell, parse error), so the repair processing can find the lines stored by a
 * previous version of this pipeline without reading the dataset back.
 */
export const shapeToWktDetailed = (value: string): ShapeResult => {
  const wkt = (value || '').replace(SRID_RE, '')
  if (!wkt) return { wkt: '', repaired: false }
  try {
    const geometry = wktToGeoJSON(wkt) as Geometry
    if (!geometry?.type || !geometry.coordinates) return { wkt: '', repaired: true }
    const rawUnsafe = !rawGeometryEsSafe(geometry)
    if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') {
      return { wkt: geojsonToWKT(roundGeometry(geometry) as any), repaired: rawUnsafe }
    }
    const cleaned = cleanGeometry(roundGeometry(geometry))
    if (!cleaned) return { wkt: '', repaired: true }
    if (!geometryNeedsRepair(cleaned)) return { wkt: geojsonToWKT(cleaned as any), repaired: rawUnsafe }
    const repaired = makeValid(cleaned)
    if (!repaired) return { wkt: '', repaired: true }
    const final = cleanGeometry(roundGeometry(repaired))
    // never emit a geometry the exact test (or data-fair's cleanCoords) could still degrade:
    // the line is better indexed without a geoshape than rejected
    if (!final || exactGeometryInvalid(final)) return { wkt: '', repaired: true }
    return { wkt: geojsonToWKT(final as any), repaired: true }
  } catch {
    return { wkt: '', repaired: true }
  }
}

export const shapeToWkt = (value: string): string => shapeToWktDetailed(value).wkt

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shapeToWkt, shapeToWktDetailed } from '../lib/geometry.ts'

// Real RNB building ASKDP3ZF62M3 (Aisne). Rounding its shape to 6 decimals makes two vertices
// collapse to 3.860652,49.865695: Elasticsearch rejects the line with "Self-intersection at or
// near point [3.860652,49.865695]". polygon-clipping splits the figure-eight into two valid rings.
test('shapeToWkt repairs RNB ASKDP3ZF62M3 (duplicate vertex after rounding)', () => {
  const result = shapeToWktDetailed('SRID=4326;MULTIPOLYGON(((3.860601413050814 49.86567576035183,3.860638030814454 49.86570425152244,3.860651776663586 49.86569517056529,3.860671444997671 49.86570760974387,3.860708664808459 49.86568937927614,3.860706515825858 49.86568783505388,3.8606853 49.8656983,3.8606654 49.86568589999999,3.8606523 49.8656953,3.860614865665716 49.86566660365371,3.860601413050814 49.86567576035183)))')
  assert.equal(result.repaired, true)
  assert.equal(result.wkt, 'MULTIPOLYGON (((3.860601 49.865676, 3.860615 49.865667, 3.860652 49.865695, 3.860638 49.865704, 3.860601 49.865676)), ((3.860652 49.865695, 3.860665 49.865686, 3.860685 49.865698, 3.860707 49.865688, 3.860709 49.865689, 3.860671 49.865708, 3.860652 49.865695)))')
})

// Real RNB building 38H384R45P5A (Manziat). The national export carried 46.3597725 for one vertex,
// which rounds to the same 4.907562,46.359772 as another: ES rejected the line at that point.
test('shapeToWkt repairs RNB 38H384R45P5A (duplicate vertex after rounding)', () => {
  const result = shapeToWktDetailed('MULTIPOLYGON(((4.907496 46.359593,4.907392 46.359608,4.907422 46.359706,4.907446 46.35979,4.907562 46.359772,4.907575 46.359771,4.907575 46.35977,4.907562 46.359772,4.907511 46.359591,4.907496 46.359593)))')
  assert.equal(result.repaired, true)
  assert.equal(result.wkt, 'MULTIPOLYGON (((4.907392 46.359608, 4.907496 46.359593, 4.907511 46.359591, 4.907562 46.359772, 4.907446 46.35979, 4.907422 46.359706, 4.907392 46.359608)), ((4.907562 46.359772, 4.907575 46.35977, 4.907575 46.359771, 4.907562 46.359772)))')
})

// A valid RNB polygon must pass through untouched, so a repair run only patches broken lines.
test('shapeToWktDetailed leaves a valid polygon untouched', () => {
  const wkt = 'POLYGON((3.86 49.86,3.861 49.86,3.861 49.861,3.86 49.861,3.86 49.86))'
  assert.deepEqual(shapeToWktDetailed(wkt), {
    wkt: 'POLYGON ((3.86 49.86, 3.861 49.86, 3.861 49.861, 3.86 49.861, 3.86 49.86))',
    repaired: false
  })
})

// "at least 4 polygon points required": a ring replaying the same two points collapses to nothing
// and must not reach Elasticsearch as a polygon.
test('shapeToWkt drops a degenerate two-point ring', () => {
  assert.deepEqual(
    shapeToWktDetailed('POLYGON((3.86 49.86,3.861 49.861,3.86 49.86,3.861 49.861,3.86 49.86))'),
    { wkt: '', repaired: true }
  )
  assert.equal(shapeToWkt('POLYGON((3.86 49.86,3.861 49.861,3.86 49.86,3.861 49.861,3.86 49.86))'), '')
})

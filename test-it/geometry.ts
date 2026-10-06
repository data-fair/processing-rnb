import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shapeToWkt, shapeToWktDetailed, legacyRepairNeeded } from '../lib/geometry.ts'

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
// polygon-clipping splits the figure-eight, and the 0.05 m² sliver it leaves is dropped: ES'
// tessellator has no use for it.
test('shapeToWkt repairs RNB 38H384R45P5A (duplicate vertex after rounding)', () => {
  const result = shapeToWktDetailed('MULTIPOLYGON(((4.907496 46.359593,4.907392 46.359608,4.907422 46.359706,4.907446 46.35979,4.907562 46.359772,4.907575 46.359771,4.907575 46.35977,4.907562 46.359772,4.907511 46.359591,4.907496 46.359593)))')
  assert.equal(result.repaired, true)
  assert.equal(result.wkt, 'POLYGON ((4.907392 46.359608, 4.907496 46.359593, 4.907511 46.359591, 4.907562 46.359772, 4.907446 46.35979, 4.907422 46.359706, 4.907392 46.359608))')
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

// The raw shape stored by the first releases of the plugin is not closed. The rounded output is
// valid, but `repaired` must still be true: the repair pass has to rewrite the stored shape.
test('shapeToWktDetailed flags an unclosed raw ring as repaired', () => {
  assert.deepEqual(shapeToWktDetailed('POLYGON((0 0,1 0,1 1,0 1))'), {
    wkt: 'POLYGON ((0 0, 1 0, 1 1, 0 1, 0 0))',
    repaired: true
  })
})

// A degenerate part next to a valid one: "at least 4 polygon points required" on the stored shape,
// while the rounded geometry keeps only the valid part.
test('shapeToWktDetailed drops a degenerate multipolygon part and flags the line', () => {
  assert.deepEqual(shapeToWktDetailed('MULTIPOLYGON(((0 0,1 0,1 1,0 1,0 0)),((2 2,2 2,2 2,2 2)))'), {
    wkt: 'POLYGON ((0 0, 1 0, 1 1, 0 1, 0 0))',
    repaired: true
  })
})

// A hole outside its shell makes ES reject the line ("illegal hole"): it is dropped.
test('shapeToWktDetailed drops a hole that escapes its shell', () => {
  assert.deepEqual(shapeToWktDetailed('POLYGON((0 0,10 0,10 10,0 10,0 0),(20 20,21 20,21 21,20 20))'), {
    wkt: 'POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0))',
    repaired: true
  })
})

// A hole inside its shell is preserved.
test('shapeToWktDetailed keeps a valid hole', () => {
  assert.deepEqual(shapeToWktDetailed('POLYGON((0 0,10 0,10 10,0 10,0 0),(2 2,2 3,3 3,3 2,2 2))'), {
    wkt: 'POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0), (2 2, 2 3, 3 3, 3 2, 2 2))',
    repaired: false
  })
})

// v1.0.2 trusted sweepline-intersections, which flags figures that merely touch at a vertex (two
// polygons sharing a corner, a hole touching its shell). The exact test tolerates them, so the
// repair pass would skip the union output v1.0.2 stored: legacyRepairNeeded must flag those lines.
test('legacyRepairNeeded flags what only the v1.0.2 sweepline detector repaired', () => {
  const touchingParts = 'MULTIPOLYGON(((0 0,1 0,1 1,0 1,0 0)),((1 1,2 1,2 2,1 2,1 1)))'
  assert.equal(shapeToWktDetailed(touchingParts).repaired, false)
  assert.equal(legacyRepairNeeded(touchingParts), true)

  const touchingHole = 'POLYGON((0 0,10 0,10 10,0 10,0 0),(0 0,2 1,1 2,0 0))'
  assert.equal(shapeToWktDetailed(touchingHole).repaired, false)
  assert.equal(legacyRepairNeeded(touchingHole), true)

  const healthy = 'POLYGON((3.86 49.86,3.861 49.86,3.861 49.861,3.86 49.861,3.86 49.86))'
  assert.equal(legacyRepairNeeded(healthy), false)
  assert.equal(legacyRepairNeeded('POINT(3.86 49.86)'), false)
})

// Shapes stored by v1.0.2 for RNB S5CAKN8GTZSD (Falaise): polygon-clipping output whose second
// polygon is a 3e-6-degree degenerate triangle. Elasticsearch 9.0 refuses it ("Unable to Tessellate
// shape"), the repair pass must turn it back into the single valid polygon.
test('shapeToWktDetailed repairs the legacy union output of RNB S5CAKN8GTZSD', () => {
  const result = shapeToWktDetailed('MULTIPOLYGON (((-0.206076 48.89837, -0.206042 48.898327, -0.205927 48.898366, -0.205929 48.898365, -0.205947 48.898388, -0.205963 48.898408, -0.206076 48.89837)), ((-0.205927 48.898366, -0.205924 48.898366, -0.205925 48.898366, -0.205927 48.898366)))')
  assert.equal(result.repaired, true)
  assert.equal(result.wkt, 'POLYGON ((-0.206076 48.89837, -0.206042 48.898327, -0.205929 48.898365, -0.205947 48.898388, -0.205963 48.898408, -0.206076 48.89837))')
})

// Shapes stored by v1.0.2 for RNB 9J52TY1ENSWP (Alsace): the sweepline detector unioned a
// near-degenerate kink the exact test tolerates, leaving the main polygon plus a 1e-6-degree
// triangle. The resulting multipolygon is refused by Elasticsearch, the repair pass must drop the
// residual kink.
test('shapeToWktDetailed repairs the legacy union output of RNB 9J52TY1ENSWP', () => {
  const result = shapeToWktDetailed('MULTIPOLYGON (((7.917987 48.899459, 7.918013 48.899452, 7.918002 48.899431, 7.918062 48.899415, 7.918052 48.899396, 7.918045 48.899384, 7.918127 48.899366, 7.918114 48.899341, 7.918128 48.899366, 7.918178 48.899455, 7.918177 48.899453, 7.918152 48.89946, 7.918214 48.899565, 7.918154 48.899578, 7.918067 48.899597, 7.917987 48.899459)), ((7.918178 48.899455, 7.91818 48.899457, 7.918179 48.899456, 7.918178 48.899455)))')
  assert.equal(result.repaired, true)
  assert.equal(result.wkt, 'POLYGON ((7.917987 48.899459, 7.918013 48.899452, 7.918002 48.899431, 7.918062 48.899415, 7.918052 48.899396, 7.918045 48.899384, 7.918127 48.899366, 7.918114 48.899341, 7.918128 48.899366, 7.918177 48.899453, 7.918152 48.89946, 7.918214 48.899565, 7.918154 48.899578, 7.918067 48.899597, 7.917987 48.899459))')
})

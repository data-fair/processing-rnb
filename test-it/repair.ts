import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'
import { parseErroredLines, repairErroredLines, repairRow, runRepair } from '../lib/repair.ts'

const log = () => ({
  step: async () => {},
  info: async () => {},
  warning: async () => {},
  error: async () => {},
  debug: async () => {},
  task: async () => {},
  progress: async () => {}
})

const repairContext = (journal: any[], extras: Record<string, any> = {}) => {
  const calls: string[] = []
  const patches: any[] = []
  const configs: any[] = []
  const axios = {
    get: async (url: string) => {
      calls.push(url)
      if (url.endsWith('/journal')) return { data: journal }
      return { data: { id: 'ds1', title: 'Bâtiments RNB', extras } }
    },
    patch: async (url: string, body: any) => {
      patches.push(body)
      return { data: {} }
    }
  }
  const context = {
    processingConfig: { datasetMode: 'repair', dataset: { id: 'ds1' } },
    log: log(),
    axios,
    patchConfig: async (patch: any) => { configs.push(patch) }
  }
  return { context: context as any, calls, patches, configs }
}

// A journal without an indexing error ("Ligne <_i>") must short-circuit before the export scan,
// which is the whole point of reading it first. The processing then goes back to update mode: left
// in repair mode, a scheduled processing would stop applying the nightly diff.
test('runRepair does not scan the export when the journal has no indexing error', async () => {
  const { context, calls, patches, configs } = repairContext([{ type: 'error', data: 'indexation refusée par elasticsearch pour 1 ligne(s) : boom' }])
  await runRepair(context)
  assert.deepEqual(calls, ['api/v1/datasets/ds1', 'api/v1/datasets/ds1/journal'])
  assert.deepEqual(configs, [{ datasetMode: 'update', dataset: { id: 'ds1', title: 'Bâtiments RNB' } }])
  assert.equal(typeof patches[0].extras.rnbLastRepair, 'string')
})

// The journal keeps its last indexing error forever: once a repair has run, the errors logged
// before it must not trigger another 12 GB export scan.
test('runRepair ignores the journal errors older than the last repair', async () => {
  const { context, calls, configs } = repairContext([
    { type: 'finalize-end', date: '2026-10-07T10:00:00.000Z' },
    { type: 'error', date: '2026-10-06T09:00:00.000Z', data: ' - Ligne 1: Polygon self-intersection at lat=48.5 lon=1.38' }
  ], { rnbLastRepair: '2026-10-06T12:00:00.000Z' })
  await runRepair(context)
  assert.deepEqual(calls, ['api/v1/datasets/ds1', 'api/v1/datasets/ds1/journal'])
  assert.equal(configs[0].datasetMode, 'update')
})

// A contour that cannot be repaired falls back to the building point: an empty `shape` patch is
// dropped by data-fair (trailing empty CSV value) and the rejected line would keep its broken shape.
test('repairRow falls back to the point for an irreparable contour', () => {
  assert.deepEqual(
    repairRow({
      rnb_id: 'S5CAKN8GTZSD',
      point: 'SRID=4326;POINT(-0.206002947992377 48.89836806844313)',
      shape: 'SRID=4326;MULTIPOLYGON(((4.03 49.42)))'
    }),
    { _action: 'patch', rnb_id: 'S5CAKN8GTZSD', shape: 'POINT (-0.206003 48.898368)' }
  )
})

// A shape the exact test tolerates but the v1.0.2 sweepline detector unioned must be rewritten:
// the union output it stored is refused by Elasticsearch.
test('repairRow rewrites a shape only the v1.0.2 sweepline detector repaired', () => {
  assert.deepEqual(
    repairRow({
      rnb_id: 'X',
      point: 'SRID=4326;POINT(1 2)',
      shape: 'MULTIPOLYGON(((0 0,1 0,1 1,0 1,0 0)),((1 1,2 1,2 2,1 2,1 1)))'
    }),
    { _action: 'patch', rnb_id: 'X', shape: 'MULTIPOLYGON (((0 0, 1 0, 1 1, 0 1, 0 0)), ((1 1, 2 1, 2 2, 1 2, 1 1)))' }
  )
})

test('repairRow leaves a healthy contour untouched', () => {
  assert.equal(repairRow({
    rnb_id: 'X',
    point: 'SRID=4326;POINT(1 2)',
    shape: 'POLYGON((3.86 49.86,3.861 49.86,3.861 49.861,3.86 49.861,3.86 49.86))'
  }), null)
})

// The journal stores data-fair's truncated summary, but the first coordinate of the refused shape
// survives: it locates the building whose stored shape must be read and repaired.
test('parseErroredLines reads the _i and the first coordinate of each error', () => {
  assert.deepEqual(parseErroredLines([
    ' - Ligne 308280081630: Unable to Tessellate shape [[48.898366, -0.205925] [48.89...[48.898366, -0.205925] ]. Possible malformed shape detected.',
    ' - Ligne 646054052951: Unable to Tessellate shape [[48.595581, 1.38452] [48.5956...] [48.595581, 1.38452] ]. Possible malformed shape detected.',
    ' - Ligne 1: Polygon self-intersection at lat=48.5 lon=1.38',
    // production journal of 2026-10-06: this message is in [lon,lat] order
    ' - Ligne 12: Self-intersection at or near point [3.860652,49.865695]'
  ].join('\n')), [
    { i: 308280081630, at: [48.898366, -0.205925] },
    { i: 646054052951, at: [48.595581, 1.38452] },
    { i: 1, at: [48.5, 1.38] },
    { i: 12, at: [49.865695, 3.860652] }
  ])

  assert.deepEqual(parseErroredLines('indexation refusée par elasticsearch pour 1 ligne(s) : boom'), [])
})

// The stored shape of the lines the journal names is read back from the dataset (the export scan
// cannot diagnose a shape taken from an older export snapshot) and rewritten in place.
test('repairErroredLines rewrites the stored shape behind an errored journal line', async () => {
  const id = 'f0e25acc6df0ffb6a41fd716dead5772009a7641aadc56f1803743781f4c15d2'
  const posts: { url: string, body: any }[] = []
  const axios = {
    get: async (url: string) => {
      if (url.endsWith('/closest/')) return { data: { results: [{ rnb_id: 'S5CAKN8GTZSD' }] } }
      if (url.includes(`/lines/${id}`)) {
        return {
          data: {
            rnb_id: 'S5CAKN8GTZSD',
            point: '48.898368,-0.206003',
            shape: 'MULTIPOLYGON (((-0.206076 48.89837, -0.206042 48.898327, -0.205927 48.898366, -0.205929 48.898365, -0.205947 48.898388, -0.205963 48.898408, -0.206076 48.89837)), ((-0.205927 48.898366, -0.205924 48.898366, -0.205925 48.898366, -0.205927 48.898366)))'
          }
        }
      }
      throw new Error('unexpected GET ' + url)
    },
    post: async (url: string, body: any) => {
      posts.push({ url, body })
      return { data: { nbErrors: 0 } }
    }
  }
  const patched = await repairErroredLines(
    axios as any,
    { id: 'ds1', title: 'Bâtiments RNB', rest: { primaryKeyMode: 'sha256' } },
    [{ i: 308280081630, at: [48.898366, -0.205925] }],
    log()
  )
  assert.deepEqual([...patched], ['S5CAKN8GTZSD'])
  assert.equal(posts.length, 1)
  assert.match(posts[0].url, /_bulk_lines$/)
  const csv = gunzipSync(posts[0].body).toString()
  assert.match(csv, /^_action,shape,rnb_id$/m)
  assert.match(csv, /POLYGON \(\(-0\.206076 48\.89837/)
})

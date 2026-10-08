import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { pushRows } from '../lib/datasets.ts'
import { diffEndBound, runDiff } from '../lib/diff.ts'

const log = () => ({
  step: async () => {},
  info: async () => {},
  warning: async () => {},
  error: async () => {},
  debug: async () => {},
  task: async () => {},
  progress: async () => {}
})

const rows = [{ _action: 'delete' as const, rnb_id: 'A' }, { _action: 'createOrUpdate' as const, rnb_id: 'B' }]
const poster = (answer: () => any) => ({ post: async () => answer() }) as any

// A replayed diff deletes lines already gone: data-fair reports them as 404, they are in the wanted
// state and must not fail the run (the production sync was stuck on them).
test('pushRows counts a 404 as a missing line, not a failure', async () => {
  const result = await pushRows(poster(() => ({ data: { nbOk: 1, nbErrors: 1, errors: [{ line: 0, status: 404, error: 'ligne non trouvée' }] } })), 'ds1', rows, log())
  assert.deepEqual(result, { missing: 1, rejected: 0 })
})

// data-fair answers 400 when the first lines are all rejected, the body is still the summary.
test('pushRows reads the summary of a 400 answer', async () => {
  const result = await pushRows(poster(() => {
    throw Object.assign(new Error('400'), { status: 400, data: { nbOk: 0, nbErrors: 2, errors: [{ line: 0, status: 404 }, { line: 1, status: 400, error: 'invalide' }] } })
  }), 'ds1', rows, log())
  assert.deepEqual(result, { missing: 1, rejected: 1 })
})

// Only the first 50 errors are detailed: when all of them are 404, so are the others.
test('pushRows extrapolates the 404s beyond the 50 detailed errors', async () => {
  const errors = Array.from({ length: 50 }, (_, line) => ({ line, status: 404 }))
  const result = await pushRows(poster(() => ({ data: { nbErrors: 120, errors } })), 'ds1', rows, log())
  assert.deepEqual(result, { missing: 120, rejected: 0 })
})

// A request that failed midway, or a cancelled drop, did not apply the batch: it must throw.
test('pushRows throws when the batch was not applied', async () => {
  await assert.rejects(pushRows(poster(() => ({ data: { nbErrors: 1, errors: [{ line: -1, status: 500, error: 'boom' }] } })), 'ds1', rows, log()), /boom/)
  await assert.rejects(pushRows(poster(() => ({ data: { nbErrors: 1, cancelled: true, errors: [{ line: 3, status: 400 }] } })), 'ds1', rows, log(), { drop: true }), /drop annulé/)
})

test('diffEndBound reads the upper bound of the diff file name', () => {
  assert.equal(
    diffEndBound('attachment; filename="diff_2026-10-08T08:07:40+00:00_2026-10-08T09:43:35.266832+00:00.csv"'),
    '2026-10-08T09:43:35.266Z'
  )
  assert.equal(diffEndBound(undefined), null)
})

const diffCsv = [
  'action,rnb_id,status,is_active,sys_period,point,shape,addresses_id,ext_ids,parent_buildings,event_id,event_type,username,user_organization_name,user_organization_id,validated_by',
  'deactivate,XRHNX11HEQV3,constructed,0,"[""2026-10-07 06:11:09.723095+00"",)",,,[],[],,,,,,,[]',
  'update,VZ5C4FS7FWBQ,demolished,1,"[""2026-10-07 18:39:03.327302+00"",)",SRID=4326;POINT(2.507106570023998 48.19909333629076),,"[""45056_0051_00013""]",[],,,,,,,[]'
].join('\n')

const diffContext = (post: () => any, csv = diffCsv) => {
  const patches: any[] = []
  const axios = {
    get: async (url: string) => {
      if (url.endsWith('/diff/')) {
        return {
          data: Readable.from([csv]),
          headers: { 'content-disposition': 'attachment; filename="diff_2026-10-06T09:34:24+00:00_2026-10-08T09:43:35.266832+00:00.csv"' }
        }
      }
      return { data: { id: 'ds1', title: 'Bâtiments RNB', extras: { rnbLastSync: '2026-10-06T09:34:24.000Z' } } }
    },
    post: async () => post(),
    patch: async (url: string, body: any) => { patches.push(body.extras) }
  }
  const context = { processingConfig: { datasetMode: 'update', dataset: { id: 'ds1' } }, log: log(), axios }
  return { context: context as any, patches }
}

// The production sync was stuck on 2026-10-06: the replayed deactivation of a line already deleted
// came back as a 404 and failed every run. It is now applied and the sync date moves on.
test('runDiff moves the sync date past a replayed delete', async () => {
  const { context, patches } = diffContext(() => ({ data: { nbOk: 1, nbErrors: 1, errors: [{ line: 0, status: 404 }] } }))
  await runDiff(context)
  assert.equal(patches.at(-1).rnbLastSync, '2026-10-07T18:39:03.327Z')
})

// An empty diff moves the sync date to the API's own bound, not to the request time.
test('runDiff stores the API bound after an empty diff', async () => {
  const { context, patches } = diffContext(() => { throw new Error('no post expected') }, diffCsv.split('\n')[0])
  await runDiff(context)
  assert.deepEqual(patches, [{ rnbLastSync: '2026-10-08T09:43:35.266Z' }])
})

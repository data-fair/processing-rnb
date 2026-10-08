import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { runFullImport } from '../lib/full-import.ts'

const log = () => ({
  step: async () => {},
  info: async () => {},
  warning: async () => {},
  error: async () => {},
  debug: async () => {},
  task: async () => {},
  progress: async () => {}
})

// 5 lines (ID0…ID4) in the national export format
const archive = path.join(import.meta.dirname, 'fixtures/export.zip')

const importContext = (extras: Record<string, any>) => {
  const posts: { url: string, ids: string[] }[] = []
  const patches: any[] = []
  const axios = {
    get: async () => ({
      data: fs.createReadStream(archive),
      headers: { etag: '"abc-1"', 'last-modified': 'Sun, 04 Oct 2026 11:16:21 GMT' }
    }),
    post: async (url: string, body: Buffer) => {
      posts.push({ url, ids: gunzipSync(body).toString().trim().split('\n').slice(1).map(line => line.split(',')[1]) })
      return { data: { nbOk: 1, nbErrors: 0 } }
    },
    patch: async (url: string, body: any) => { patches.push(JSON.parse(JSON.stringify(body.extras))) }
  }
  const context = { processingConfig: { datasetMode: 'update', dataset: { id: 'ds1' } }, log: log(), axios }
  return { context: context as any, posts, patches, dataset: { id: 'ds1', title: 'Bâtiments RNB', extras } }
}

// The export is a snapshot older than the import: the diff must restart before its publication
// date (Last-Modified minus a margin), not at the import time, or the modifications in between are
// never applied.
test('runFullImport restarts the diff before the export publication date', async () => {
  const { context, posts, patches, dataset } = importContext({ rnbImporting: true })
  await runFullImport(context, { dataset, drop: true })
  assert.deepEqual(posts, [{ url: 'api/v1/datasets/ds1/_bulk_lines?drop=true', ids: ['ID0', 'ID1', 'ID2', 'ID3', 'ID4'] }])
  assert.deepEqual(patches.at(-1), { rnbImporting: false, rnbLastSync: '2026-10-02T11:16:21.000Z' })
})

// Same archive as the interrupted run: the lines already pushed are skipped, without drop.
test('runFullImport resumes an interrupted import of the same archive', async () => {
  const { context, posts, dataset } = importContext({ rnbImporting: true, rnbImportEtag: '"abc-1"', rnbImportedLines: 3 })
  await runFullImport(context, { dataset, drop: true })
  assert.deepEqual(posts, [{ url: 'api/v1/datasets/ds1/_bulk_lines', ids: ['ID3', 'ID4'] }])
})

// Another archive: the partial load is cleared with drop.
test('runFullImport restarts with drop when the archive changed', async () => {
  const { context, posts, dataset } = importContext({ rnbImporting: true, rnbImportEtag: '"old"', rnbImportedLines: 3 })
  await runFullImport(context, { dataset, drop: true })
  assert.deepEqual(posts, [{ url: 'api/v1/datasets/ds1/_bulk_lines?drop=true', ids: ['ID0', 'ID1', 'ID2', 'ID3', 'ID4'] }])
})

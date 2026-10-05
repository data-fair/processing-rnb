import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runRepair } from '../lib/repair.ts'

const log = () => ({
  step: async () => {},
  info: async () => {},
  warning: async () => {},
  error: async () => {},
  debug: async () => {},
  task: async () => {},
  progress: async () => {}
})

// A journal without an indexing error ("Ligne <_i>") must short-circuit before the export scan,
// which is the whole point of reading it first.
test('runRepair does not scan the export when the journal has no indexing error', async () => {
  const calls: string[] = []
  const axios = {
    get: async (url: string) => {
      calls.push(url)
      if (url.endsWith('/journal')) {
        return { data: [{ type: 'error', data: 'indexation refusée par elasticsearch pour 1 ligne(s) : boom' }] }
      }
      return { data: { id: 'ds1', title: 'Bâtiments RNB' } }
    }
  }
  await runRepair({
    processingConfig: { datasetMode: 'repair', dataset: { id: 'ds1' } },
    log: log(),
    axios
  } as any)
  assert.deepEqual(calls, ['api/v1/datasets/ds1', 'api/v1/datasets/ds1/journal'])
})

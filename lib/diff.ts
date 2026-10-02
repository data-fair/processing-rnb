import { parse } from 'csv-parse'
import type { ProcessingContext } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from '#types/processingConfig/index.ts'
import { getDataset, patchExtras, pushRows } from './datasets.ts'
import { runFullImport } from './full-import.ts'
import { diffRowToDatasetRow, type DatasetRow } from './transform.ts'
import { BATCH_SIZE, RNB_API_URL, isStopped } from './utils.ts'

const DAY_MS = 24 * 3600 * 1000

/**
 * Nightly sync: fetch the RNB diff since the last applied modification and upsert/delete the
 * matching lines. The diff CSV already carries every column of the dataset, so no per-building
 * detail call is needed.
 */
export const runDiff = async (context: ProcessingContext<ProcessingConfig>): Promise<void> => {
  const { processingConfig, log, axios } = context
  const datasetId = processingConfig.datasetMode === 'update' ? processingConfig.dataset.id : undefined
  if (!datasetId) throw new Error('Jeu de données à mettre à jour manquant, enregistrez la configuration avant de lancer le traitement.')

  await log.step('Lecture du jeu de données')
  const dataset = await getDataset(axios, datasetId)
  if (dataset.extras?.rnbImporting) {
    await log.warning("Import initial incomplet détecté : reprise de l'import national complet")
    await runFullImport(context, { dataset, drop: true })
    return
  }

  const requestStart = new Date().toISOString()
  const since = typeof dataset.extras?.rnbLastSync === 'string' && dataset.extras.rnbLastSync
    ? dataset.extras.rnbLastSync
    : new Date(Date.now() - DAY_MS).toISOString()
  await log.step(`Récupération du différentiel RNB depuis ${since}`)

  const response = await axios.get(`${RNB_API_URL}/diff/`, {
    params: { since, ...(processingConfig.fromEmail ? { from: processingConfig.fromEmail } : {}) },
    responseType: 'stream',
    maxRedirects: 5,
    timeout: 0
  }).catch((err: any) => {
    if ((err?.response?.status ?? err?.status) === 400) {
      throw new Error(`L'API RNB a refusé la date « ${since} » (diff limité à 6 mois). Un import complet est nécessaire pour repartir d'une base à jour.`)
    }
    throw err
  })
  const parser = response.data.pipe(parse({ columns: true, delimiter: ',', quote: '"', relax_column_count: true, skip_empty_lines: true }))
  response.data.on('error', (err: Error) => parser.destroy(err))

  // the diff is sorted by modification date: the last line seen for an id wins, and re-inserting
  // keeps the map ordered by last occurrence so a batch's timestamps stay monotonic
  const byId = new Map<string, DatasetRow>()
  let ignored = 0
  for await (const record of parser as AsyncIterable<Record<string, string>>) {
    const row = diffRowToDatasetRow(record)
    if (!row) {
      ignored++
      continue
    }
    byId.delete(row.rnb_id)
    byId.set(row.rnb_id, row)
  }
  if (ignored) await log.warning(`${ignored} lignes du différentiel ignorées (action inconnue)`)

  const rows = [...byId.values()]
  if (!rows.length) {
    await patchExtras(axios, dataset, { rnbLastSync: requestStart }, log)
    await log.info('Aucune modification à appliquer')
    return
  }

  let total = 0
  let lastSync = ''
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    if (isStopped()) {
      await log.warning(`Traitement interrompu — ${total} / ${rows.length} modifications appliquées`)
      return
    }
    const batch = rows.slice(i, i + BATCH_SIZE)
    await pushRows(axios, dataset.id, batch, log)
    total += batch.length
    const timestamps = batch.map(row => row.modified_at).filter(Boolean).sort() as string[]
    if (timestamps.length) {
      lastSync = timestamps[timestamps.length - 1]
      // persist after each batch: a crash resumes from the last applied modification, not from scratch
      await patchExtras(axios, dataset, { rnbLastSync: lastSync }, log)
    }
    await log.progress('Modifications appliquées', total, rows.length)
  }

  if (!lastSync) await patchExtras(axios, dataset, { rnbLastSync: requestStart }, log)
  await log.info(`${total} bâtiments mis à jour (créations, modifications et suppressions)`)
}

import { parse } from 'csv-parse'
import unzipper from 'unzipper'
import type { AxiosInstance } from 'axios'
import type { ProcessingContext } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from '#types/processingConfig/index.ts'
import { createRnbDataset, patchExtras, pushRows, type RnbDataset } from './datasets.ts'
import { exportRowToDatasetRow, type DatasetRow } from './transform.ts'
import {
  BATCH_SIZE,
  DEFAULT_SOURCE_URL,
  EXPORT_ENTRY_NAME,
  EXPORT_SYNC_MARGIN_MS,
  IMPORT_TOTAL_ESTIMATE,
  PROGRESS_EVERY,
  isStopped
} from './utils.ts'

/**
 * Stream the national export archive from its URL and return the parsed CSV lines, without ever
 * writing the archive to disk. Errors on any stream of the chain are forwarded to the parser, so
 * the async iterator rejects instead of leaving an unhandled error. `abort` kills the HTTP request,
 * for a stopped run. `etag` identifies the archive (same lines in the same order), `lastModified`
 * dates its publication.
 */
export const openExportParser = async (
  axios: AxiosInstance,
  sourceUrl: string
): Promise<{ records: AsyncIterable<Record<string, string>>, abort: () => void, etag?: string, lastModified?: Date }> => {
  const controller = new AbortController()
  const response = await axios.get(sourceUrl, { responseType: 'stream', maxRedirects: 5, timeout: 0, signal: controller.signal })
  const zip = response.data.pipe(unzipper.Parse())
  const parser = parse({ columns: true, delimiter: ';', quote: '"', relax_column_count: true, skip_empty_lines: true })
  let matched = false
  zip.on('entry', (entry: any) => {
    if (entry.path === EXPORT_ENTRY_NAME) {
      matched = true
      entry.pipe(parser)
    } else {
      entry.autodrain()
    }
  })
  zip.on('error', (err: Error) => parser.destroy(err))
  zip.on('close', () => {
    if (!matched) parser.destroy(new Error(`Entrée ${EXPORT_ENTRY_NAME} introuvable dans l'archive ${sourceUrl}`))
  })
  response.data.on('error', (err: Error) => parser.destroy(err))
  const etag = typeof response.headers?.etag === 'string' ? response.headers.etag : undefined
  const lastModified = response.headers?.['last-modified'] ? new Date(response.headers['last-modified']) : undefined
  return {
    records: parser,
    abort: () => controller.abort(),
    etag,
    lastModified: lastModified && !Number.isNaN(lastModified.getTime()) ? lastModified : undefined
  }
}

/**
 * Full national import: download the export archive, stream-decompress it into the dataset.
 * Nothing is written to disk. A run interrupted halfway leaves `rnbImporting` true in the dataset
 * extras, and the next update run restarts this import. The lines already pushed are saved with the
 * archive ETag (`rnbImportEtag`, `rnbImportedLines`): when the archive is the same, the restart
 * skips them (a deflate stream cannot be resumed mid-way, it is re-read but not re-uploaded);
 * otherwise it restarts with `drop` to clear the partial load.
 */
export const runFullImport = async (
  context: ProcessingContext<ProcessingConfig>,
  options: { dataset?: RnbDataset, drop?: boolean } = {}
): Promise<void> => {
  const { processingConfig, log, axios, patchConfig, processingId } = context
  const startedAt = new Date().toISOString()
  let dataset = options.dataset

  if (!dataset) {
    await log.step('Création du jeu de données')
    const title = processingConfig.datasetMode === 'create' ? processingConfig.datasetTitle : 'Bâtiments RNB'
    dataset = await createRnbDataset(axios, title, { processingId, rnbImporting: true }, log)
    // switch to update mode right away, so a crash mid-import does not create a second dataset
    await patchConfig({ datasetMode: 'update', dataset: { id: dataset.id, title: dataset.title } })
  }

  const sourceUrl = processingConfig.sourceUrl || DEFAULT_SOURCE_URL
  await log.step("Téléchargement de l'export national RNB")
  await log.info(`Source : ${sourceUrl}`)
  const { records, abort, etag, lastModified } = await openExportParser(axios, sourceUrl)

  const resuming = !!etag && dataset.extras?.rnbImportEtag === etag
  const skip = resuming && typeof dataset.extras?.rnbImportedLines === 'number' ? dataset.extras.rnbImportedLines : 0
  if (resuming) await log.info(`Reprise de l'import sur la même archive : ${skip} lignes déjà importées sont ignorées`)

  let batch: DatasetRow[] = []
  let total = skip
  let skipped = 0
  let batches = 0
  let drop = options.drop === true && !resuming
  let stopped = false

  try {
    for await (const record of records) {
      if (isStopped()) {
        stopped = true
        break
      }
      if (skipped < skip) {
        skipped++
        continue
      }
      batch.push(exportRowToDatasetRow(record))
      if (batch.length < BATCH_SIZE) continue
      await pushRows(axios, dataset.id, batch, log, { drop })
      drop = false
      total += batch.length
      batch = []
      batches++
      if (batches % PROGRESS_EVERY === 0) {
        if (etag) await patchExtras(axios, dataset, { rnbImportEtag: etag, rnbImportedLines: total }, log)
        await log.progress('Bâtiments importés', Math.min(total, IMPORT_TOTAL_ESTIMATE), IMPORT_TOTAL_ESTIMATE)
      }
    }
  } finally {
    abort()
  }

  if (stopped) {
    await log.warning(`Import interrompu — ${total} bâtiments importés, le prochain lancement reprendra l'import`)
    return
  }
  if (batch.length) {
    await pushRows(axios, dataset.id, batch, log, { drop })
    total += batch.length
  }

  if (total) await log.progress('Bâtiments importés', total, total)
  // the export is a snapshot older than its publication: the diff restarts a margin before it, the
  // modifications replayed in between are idempotent
  const exportDate = lastModified ?? new Date(startedAt)
  const rnbLastSync = new Date(exportDate.getTime() - EXPORT_SYNC_MARGIN_MS).toISOString()
  await patchExtras(axios, dataset, { rnbImporting: false, rnbLastSync, rnbImportEtag: undefined, rnbImportedLines: undefined }, log)
  await log.info(`Le différentiel reprendra depuis ${rnbLastSync} (export publié le ${exportDate.toISOString()})`)
  await log.info(`${total} bâtiments importés dans « ${dataset.title} » (${dataset.id})`)
}

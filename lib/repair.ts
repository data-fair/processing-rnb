import type { AxiosInstance } from 'axios'
import type { ProcessingContext, LogFunctions } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from '#types/processingConfig/index.ts'
import { getDataset, pushRows } from './datasets.ts'
import { openExportParser } from './full-import.ts'
import { shapeToWktDetailed } from './geometry.ts'
import { PATCH_COLUMNS } from './schemas.ts'
import type { DatasetRow } from './transform.ts'
import {
  BATCH_SIZE,
  DEFAULT_SOURCE_URL,
  IMPORT_TOTAL_ESTIMATE,
  PROGRESS_EVERY,
  isStopped
} from './utils.ts'

const LINE_RE = /Ligne (\d+)/g
/** Patched contours logged at the end of the run, to identify a line that would still be rejected. */
const PATCH_LOG_SAMPLE = 20

/**
 * The journal's last indexing error lists up to 3 lines as "Ligne <_i>: <reason>" (data-fair's
 * errorsSummary). It is only used to skip the export scan when there is nothing to repair. Returns
 * null when the journal cannot be read, so the caller scans anyway.
 */
const readErroredLines = async (
  axios: AxiosInstance,
  datasetId: string,
  log: LogFunctions
): Promise<{ lines: number[], date?: string } | null> => {
  try {
    const events = (await axios.get(`api/v1/datasets/${datasetId}/journal`)).data as any[]
    for (const event of events ?? []) {
      if (event?.type !== 'error' || typeof event.data !== 'string') continue
      const matches = [...event.data.matchAll(LINE_RE)]
      if (matches.length) {
        return {
          lines: matches.map(match => Number(match[1])),
          date: typeof event.date === 'string' ? event.date : undefined
        }
      }
    }
    return { lines: [] }
  } catch (err: any) {
    await log.warning("Journal illisible, analyse de l'export national par défaut", err.response?.data ?? err.data)
    return null
  }
}

/**
 * Repair the lines stored by a previous version of the geometry pipeline: re-stream the national
 * export and `patch` the `shape` of the buildings whose stored shape the current pipeline would not
 * have written (raw kink, self-intersection, degenerate ring, escaped hole). Nothing else is written
 * (no `drop`, no full dataset rewrite), so the dataset is repaired in place.
 */
export const runRepair = async (context: ProcessingContext<ProcessingConfig>): Promise<void> => {
  const { processingConfig, log, axios } = context
  const datasetId = processingConfig.datasetMode === 'repair' ? processingConfig.dataset?.id : undefined
  if (!datasetId) throw new Error('Jeu de données à réparer manquant.')

  await log.step('Lecture du jeu de données')
  const dataset = await getDataset(axios, datasetId)
  const errored = await readErroredLines(axios, dataset.id, log)
  if (errored && !errored.lines.length) {
    await log.info(`Aucune ligne en erreur d'indexation dans le journal de « ${dataset.title} », rien à réparer`)
    return
  }
  if (errored) {
    await log.info(`${errored.lines.length} ligne(s) en erreur détectée(s)${errored.date ? ` (journal du ${errored.date})` : ''} : ${errored.lines.join(', ')}`)
  }

  const sourceUrl = processingConfig.sourceUrl || DEFAULT_SOURCE_URL
  await log.step("Analyse de l'export national RNB")
  await log.info(`Source : ${sourceUrl}`)
  const { records, abort } = await openExportParser(axios, sourceUrl)

  let batch: DatasetRow[] = []
  let scanned = 0
  let repaired = 0
  let missing = 0
  const patchedSample: string[] = []

  const flush = async (): Promise<void> => {
    if (!batch.length) return
    missing += await pushRows(axios, dataset.id, batch, log, { columns: PATCH_COLUMNS, allowMissing: true })
    repaired += batch.length
    batch = []
  }

  try {
    for await (const record of records) {
      if (isStopped()) break
      scanned++
      const shape = shapeToWktDetailed(record.shape || '')
      if (shape.repaired && record.rnb_id) {
        if (patchedSample.length < PATCH_LOG_SAMPLE) {
          patchedSample.push(`${record.rnb_id} → ${shape.wkt || 'contour vide'} (brut : ${(record.shape || '').slice(0, 160)})`)
        }
        batch.push({ _action: 'patch', rnb_id: record.rnb_id, shape: shape.wkt })
        if (batch.length >= BATCH_SIZE) await flush()
      }
      if (scanned % (BATCH_SIZE * PROGRESS_EVERY) === 0) {
        await log.progress('Bâtiments analysés', Math.min(scanned, IMPORT_TOTAL_ESTIMATE), IMPORT_TOTAL_ESTIMATE)
      }
    }
  } finally {
    abort()
  }

  if (isStopped()) {
    await log.warning(`Réparation interrompue — ${repaired} bâtiment(s) corrigé(s), relancez le traitement pour terminer`)
    return
  }
  await flush()
  if (scanned) await log.progress('Bâtiments analysés', scanned, scanned)
  await log.info(`${repaired} bâtiment(s) corrigé(s) sur ${scanned} analysés dans « ${dataset.title} » (${dataset.id})${missing ? `, ${missing} absent(s) du jeu de données` : ''}`)
  if (patchedSample.length) await log.info(`Contours réécrits (extrait) :\n${patchedSample.join('\n')}`)
}

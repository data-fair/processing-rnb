import { createHash } from 'node:crypto'
import type { AxiosInstance } from 'axios'
import type { ProcessingContext, LogFunctions } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from '#types/processingConfig/index.ts'
import { getDataset, pushRows, type RnbDataset } from './datasets.ts'
import { openExportParser } from './full-import.ts'
import { legacyRepairNeeded, shapeToWkt, shapeToWktDetailed } from './geometry.ts'
import { PATCH_COLUMNS } from './schemas.ts'
import type { DatasetRow } from './transform.ts'
import {
  BATCH_SIZE,
  DEFAULT_SOURCE_URL,
  IMPORT_TOTAL_ESTIMATE,
  PROGRESS_EVERY,
  RNB_API_URL,
  isStopped
} from './utils.ts'

interface ErroredLine {
  /** data-fair line index (`_i`), the only handle the journal gives. */
  i: number
  /** First coordinate of the refused shape (`[lat, lon]`), when the ES message carries the polygon. */
  at?: [number, number]
}

/** Patched contours logged at the end of the run, to identify a line that would still be rejected. */
const PATCH_LOG_SAMPLE = 20

export const parseErroredLines = (data: string): ErroredLine[] => {
  const lines: ErroredLine[] = []
  for (const row of data.split('\n')) {
    const index = /Ligne (\d+)/.exec(row)
    if (!index) continue
    const polygon = /\[\[?(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\]/.exec(row)
    const point = /lat=(-?\d+(?:\.\d+)?)\s+lon=(-?\d+(?:\.\d+)?)/.exec(row)
    const at = polygon
      ? [Number(polygon[1]), Number(polygon[2])] as [number, number]
      : point
        ? [Number(point[1]), Number(point[2])] as [number, number]
        : undefined
    lines.push({ i: Number(index[1]), at })
  }
  return lines
}

/**
 * The journal's last indexing error lists up to 3 lines as "Ligne <_i>: <reason>" (data-fair's
 * errorsSummary). Returns null when the journal cannot be read, so the caller scans the export.
 */
const readErroredLines = async (
  axios: AxiosInstance,
  datasetId: string,
  log: LogFunctions
): Promise<{ lines: ErroredLine[], date?: string } | null> => {
  try {
    const events = (await axios.get(`api/v1/datasets/${datasetId}/journal`)).data as any[]
    for (const event of events ?? []) {
      if (event?.type !== 'error' || typeof event.data !== 'string') continue
      const lines = parseErroredLines(event.data)
      if (lines.length) {
        return { lines, date: typeof event.date === 'string' ? event.date : undefined }
      }
    }
    return { lines: [] }
  } catch (err: any) {
    await log.warning("Journal illisible, analyse de l'export national par défaut", err.response?.data ?? err.data)
    return null
  }
}

/** data-fair line id for a primary key value (see its `getLineId`: sha256 by default, hex of the raw JSON otherwise). */
const lineId = (dataset: RnbDataset, rnbId: string): string | undefined => {
  if (!rnbId) return undefined
  const primaryKey = JSON.stringify([rnbId])
  return dataset.rest?.primaryKeyMode === 'sha256'
    ? createHash('sha256').update(primaryKey).digest('hex')
    : Buffer.from(primaryKey.slice(2, -2)).toString('hex')
}

/** Dataset `point` column ("lat,lon") → a rounded WKT point, the fallback geometry of a line. */
const pointWkt = (value: string): string => {
  const [lat, lon] = (value || '').split(',')
  return lat && lon ? shapeToWkt(`POINT(${lon} ${lat})`) : ''
}

/**
 * Repair the lines Elasticsearch refuses: the journal names them and carries the first coordinate
 * of the refused shape, the closest RNB building gives the `rnb_id`, and the dataset read gives the
 * stored `shape`. Needed for shapes that came from an export snapshot newer than the stored line
 * (the export scan cannot see them): the stored shape alone tells what to rewrite. Returns the
 * `rnb_id`s patched, so the export scan does not overwrite them with the (poorer) export output.
 */
export const repairErroredLines = async (
  axios: AxiosInstance,
  dataset: RnbDataset,
  errored: ErroredLine[],
  log: LogFunctions,
  fromEmail?: string
): Promise<Set<string>> => {
  const rows: DatasetRow[] = []
  const patched = new Set<string>()
  for (const entry of errored) {
    if (!entry.at) continue
    let buildings: any[] = []
    try {
      const response = await axios.get(`${RNB_API_URL}/closest/`, {
        params: { point: `${entry.at[0]},${entry.at[1]}`, radius: 15, ...(fromEmail ? { from: fromEmail } : {}) }
      })
      buildings = response.data?.results ?? []
    } catch (err: any) {
      await log.warning(`Bâtiment de la ligne ${entry.i} introuvable via l'API RNB`, err.response?.data ?? err.data)
      continue
    }
    // the refused vertex belongs to the building, but a neighbour may be closest: patch only the
    // candidates whose stored shape the current pipeline would change
    for (const building of buildings.slice(0, 3)) {
      const id = lineId(dataset, building?.rnb_id)
      if (!id || patched.has(building.rnb_id)) continue
      let line: any
      try {
        line = (await axios.get(`api/v1/datasets/${dataset.id}/lines/${id}`)).data
      } catch {
        continue
      }
      const stored = line?.shape || ''
      const shape = shapeToWktDetailed(stored)
      if (!shape.repaired && shape.wkt === stored) continue
      const wkt = shape.wkt || pointWkt(line?.point || '')
      if (!wkt) continue
      patched.add(building.rnb_id)
      rows.push({ _action: 'patch', rnb_id: building.rnb_id, shape: wkt })
      await log.info(`Ligne ${entry.i} : contour stocké de ${building.rnb_id} réécrit (${wkt})`)
    }
  }
  if (rows.length) await pushRows(axios, dataset.id, rows, log, { columns: PATCH_COLUMNS, allowMissing: true })
  return patched
}

/**
 * Patch row for one export record, or null when neither the current pipeline nor the legacy v1.0.2
 * detector would rewrite the shape. A contour that cannot be repaired falls back to the building
 * point: an empty `shape` patch is dropped by data-fair (trailing empty CSV value) and the line
 * would keep its broken shape, while a point keeps the building locatable.
 */
export const repairRow = (record: Record<string, string>): DatasetRow | null => {
  const raw = record.shape || ''
  const shape = shapeToWktDetailed(raw)
  if (!shape.repaired && !legacyRepairNeeded(raw)) return null
  if (!record.rnb_id) return null
  return { _action: 'patch', rnb_id: record.rnb_id, shape: shape.wkt || shapeToWkt(record.point || '') }
}

/**
 * Repair the lines stored by a previous version of the geometry pipeline. The lines named by the
 * journal are repaired first from their stored shape (the only way to see a shape taken from an
 * older export snapshot), then the national export is re-streamed to `patch` the `shape` of the
 * buildings the current pipeline would not have written (raw kink, self-intersection, degenerate
 * ring, escaped hole) or that the v1.0.2 sweepline detector unioned into a shape Elasticsearch can
 * still refuse. A building whose contour cannot be repaired falls back to its point, never an empty
 * shape. Nothing else is written (no `drop`, no full dataset rewrite), so the dataset is repaired
 * in place.
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
    await log.info(`${errored.lines.length} ligne(s) en erreur détectée(s)${errored.date ? ` (journal du ${errored.date})` : ''} : ${errored.lines.map(line => line.i).join(', ')}`)
  }
  let patchedByJournal = new Set<string>()
  if (errored?.lines.length) {
    patchedByJournal = await repairErroredLines(axios, dataset, errored.lines, log, processingConfig.fromEmail)
    if (patchedByJournal.size) await log.info(`${patchedByJournal.size} ligne(s) du journal réparée(s) depuis leur shape stockée`)
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
      const row = repairRow(record)
      if (row && !patchedByJournal.has(row.rnb_id)) {
        if (patchedSample.length < PATCH_LOG_SAMPLE) {
          patchedSample.push(`${row.rnb_id} → ${row.shape || 'contour vide'} (brut : ${(record.shape || '').slice(0, 160)})`)
        }
        batch.push(row)
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

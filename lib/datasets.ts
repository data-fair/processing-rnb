import { gzipSync } from 'node:zlib'
import { stringify } from 'csv-stringify/sync'
import type { AxiosInstance } from 'axios'
import type { LogFunctions } from '@data-fair/lib-common-types/processings.js'
import { BULK_COLUMNS, RNB_SCHEMA } from './schemas.ts'
import { dfRetry } from './utils.ts'
import type { DatasetRow } from './transform.ts'

export interface RnbDataset {
  id: string
  title: string
  extras?: Record<string, any>
  rest?: { primaryKeyMode?: string }
}

/** Create the editable dataset that holds the buildings. */
export const createRnbDataset = async (
  axios: AxiosInstance,
  title: string,
  extras: Record<string, any>,
  log: LogFunctions
): Promise<RnbDataset> => {
  const dataset = (await dfRetry(() => axios.post('api/v1/datasets', {
    isRest: true,
    title,
    primaryKey: ['rnb_id'],
    schema: RNB_SCHEMA,
    extras
  }), log)).data
  await log.info(`Jeu de données créé : ${dataset.title} (${dataset.id})`)
  return dataset
}

export const getDataset = async (axios: AxiosInstance, id: string): Promise<RnbDataset> => {
  try {
    return (await axios.get(`api/v1/datasets/${id}`)).data
  } catch (err: any) {
    if (err.response?.status === 404) throw new Error(`Le jeu de données est introuvable (id="${id}").`)
    throw err
  }
}

export interface PushResult {
  /** Lines data-fair reported missing (404): a `delete` or `patch` of a line already gone. */
  missing: number
  /** Lines rejected for another reason, logged and skipped. */
  rejected: number
}

/**
 * Push a batch of rows through `_bulk_lines`. Each row carries its `_action` (`createOrUpdate`,
 * `patch` or `delete`), the primary key drives the match. `drop` replaces every existing line: it is
 * only used on the first batch of a restarted full import, to clear a partial load. `columns`
 * narrows the CSV so a `patch` does not overwrite the other columns with empty values.
 * A missing line (404) is already in the wanted state — a replayed diff, a building created and
 * deactivated in the same window, a repair patch on a building deleted since the export — so it is
 * only counted. Other rejected lines are logged and skipped: one bad line must not block the sync
 * forever. Only a failure of the request itself throws.
 */
export const pushRows = async (
  axios: AxiosInstance,
  datasetId: string,
  rows: DatasetRow[],
  log: LogFunctions,
  options: { drop?: boolean, columns?: string[] } = {}
): Promise<PushResult> => {
  if (!rows.length) return { missing: 0, rejected: 0 }
  const csv = stringify(rows, { header: true, columns: options.columns ?? BULK_COLUMNS })
  const body = gzipSync(csv)
  const url = `api/v1/datasets/${datasetId}/_bulk_lines${options.drop ? '?drop=true' : ''}`
  const result = (await dfRetry(() => axios.post(url, body, {
    headers: { 'content-type': 'text/csv+gzip' },
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  }).catch((err: any) => {
    // data-fair answers 400 when the first lines of the request are all rejected, but the body is
    // still the summary of the whole request
    const data = err.data ?? err.response?.data
    if ((err.status ?? err.response?.status) === 400 && typeof data?.nbErrors === 'number') return { data }
    throw err
  }), log, true)).data ?? {}
  if (!result.nbErrors) return { missing: 0, rejected: 0 }
  const errors: any[] = result.errors ?? []
  // line -1: the request itself failed midway. `cancelled`: a drop is applied all or nothing, any
  // rejected line cancels it. Either way the batch is not applied.
  const failure = errors.find(err => err.line === -1)
  if (failure || result.cancelled) {
    await log.error('Échec de l\'envoi des lignes à data-fair, lot non appliqué', failure ?? errors.slice(0, 3))
    throw new Error(`Échec de l'envoi des lignes à data-fair : ${failure?.error ?? `${result.nbErrors} lignes rejetées, drop annulé`}`)
  }
  // data-fair details the first 50 errors only: when all of them are 404, so are the others
  const others = errors.filter(err => err.status !== 404)
  const missing = others.length ? errors.length - others.length : result.nbErrors
  const rejected = result.nbErrors - missing
  if (missing) await log.info(`${missing} ligne(s) déjà absente(s) du jeu de données, ignorée(s)`)
  if (rejected) await log.warning(`${rejected} ligne(s) rejetée(s) par data-fair, ignorée(s)`, others.slice(0, 3))
  return { missing, rejected }
}

/** Merge extras into the dataset and persist them (sync state lives here, not in the config). */
export const patchExtras = async (
  axios: AxiosInstance,
  dataset: RnbDataset,
  extras: Record<string, any>,
  log: LogFunctions
): Promise<void> => {
  dataset.extras = { ...dataset.extras, ...extras }
  await dfRetry(() => axios.patch(`api/v1/datasets/${dataset.id}`, { extras: dataset.extras }), log, true)
}

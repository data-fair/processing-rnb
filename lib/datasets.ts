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

/**
 * Push a batch of rows through `_bulk_lines`. Each row carries its `_action` (`createOrUpdate`,
 * `patch` or `delete`), the primary key drives the match. `drop` replaces every existing line: it is
 * only used on the first batch of a restarted full import, to clear a partial load. `columns`
 * narrows the CSV so a `patch` does not overwrite the other columns with empty values. With
 * `allowMissing`, a patch targeting a line absent from the dataset (a building added since the
 * export) is reported as a warning instead of failing the run.
 */
export const pushRows = async (
  axios: AxiosInstance,
  datasetId: string,
  rows: DatasetRow[],
  log: LogFunctions,
  options: { drop?: boolean, columns?: string[], allowMissing?: boolean } = {}
): Promise<void> => {
  if (!rows.length) return
  const csv = stringify(rows, { header: true, columns: options.columns ?? BULK_COLUMNS })
  const body = gzipSync(csv)
  const url = `api/v1/datasets/${datasetId}/_bulk_lines${options.drop ? '?drop=true' : ''}`
  const result = (await dfRetry(() => axios.post(url, body, {
    headers: { 'content-type': 'text/csv+gzip' },
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  }), log, true)).data ?? {}
  if (result.nbErrors) {
    const errors: any[] = result.errors ?? []
    if (options.allowMissing && errors.length === result.nbErrors && errors.every(err => err.status === 404)) {
      await log.warning(`${result.nbErrors} ligne(s) absente(s) du jeu de données, patch ignoré`, errors[0])
      return
    }
    // a batch with rejected lines leaves the dataset incomplete: fail and let the run resume later
    await log.error(`${result.nbErrors} lignes rejetées par data-fair`, errors[0])
    throw new Error(`${result.nbErrors} lignes rejetées par data-fair`)
  }
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

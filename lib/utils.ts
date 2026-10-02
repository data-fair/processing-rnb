import type { LogFunctions } from '@data-fair/lib-common-types/processings.js'

/** Base URL of the RNB buildings API (alpha). */
export const RNB_API_URL = 'https://rnb-api.beta.gouv.fr/api/alpha/buildings'

/** National export published on data.gouv.fr, used by the full import only. */
export const DEFAULT_SOURCE_URL = 'https://rnb-opendata.s3.fr-par.scw.cloud/files/RNB_nat.csv.zip'

/** Name of the CSV entry inside the national export archive. */
export const EXPORT_ENTRY_NAME = 'RNB_nat.csv'

/** Lines pushed in one `_bulk_lines` request. Keeps each body around a few MB before gzip. */
export const BATCH_SIZE = 10000

/** Batches between two progress reports (10 × 10 000 = 100 000 lines). */
export const PROGRESS_EVERY = 10

/** Rough size of the RNB, only used to render the import progress bar. */
export const IMPORT_TOTAL_ESTIMATE = 43_000_000

let shouldBeStopped = false
export const resetStop = () => { shouldBeStopped = false }
export const requestStop = () => { shouldBeStopped = true }
export const isStopped = () => shouldBeStopped

type Retry429Opts = { log?: Pick<LogFunctions, 'warning'>, retries?: number, delayMs?: number, source?: string }

/**
 * Run an async call, retrying on HTTP 429 (Too Many Requests): data-fair rate-limits bursts, so we
 * pause and retry rather than failing the whole run. Only 429 is retried, other errors are
 * rethrown. `fn` is a thunk so the request is rebuilt on each attempt.
 */
export const withRetry429 = async <T>(fn: () => Promise<T>, opts: Retry429Opts = {}): Promise<T> => {
  const { log, retries = 3, delayMs = 10000, source = 'Data-Fair' } = opts
  let attempt = 0
  while (true) {
    try {
      return await fn()
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status
      if (status !== 429 || attempt >= retries) throw err
      attempt++
      if (log) await log.warning(`429 reçu de ${source} — pause ${delayMs / 1000}s avant nouvelle tentative (${attempt}/${retries})`)
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
}

/** Run a data-fair write call with the 429 retry (the worker never retries POST/PATCH). */
export const dfRetry = <T>(fn: () => Promise<T>, log?: Pick<LogFunctions, 'warning'>): Promise<T> =>
  withRetry429(fn, { log })

/** Axios hides the reason given by data-fair inside response.data; JSON.stringify(err) drops it. */
export const describeError = (err: any): string => {
  const detail = err.response?.data ?? err.data
  const body = typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : ''
  return body ? `${err.message} : ${body}` : err.message
}

import type { LogFunctions } from '@data-fair/lib-common-types/processings.js'

/** Base URL of the RNB buildings API (alpha). */
export const RNB_API_URL = 'https://rnb-api.beta.gouv.fr/api/alpha/buildings'

/** National export published on data.gouv.fr, used by the full import only. */
export const DEFAULT_SOURCE_URL = 'https://rnb-opendata.s3.fr-par.scw.cloud/files/RNB_nat.csv.zip'

/** Name of the CSV entry inside the national export archive. */
export const EXPORT_ENTRY_NAME = 'RNB_nat.csv'

/**
 * The diff following a full import restarts this long before the export publication date: the
 * export is a database snapshot taken some time before it is published.
 */
export const EXPORT_SYNC_MARGIN_MS = 2 * 24 * 3600 * 1000

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

type Retry429Opts = { log?: Pick<LogFunctions, 'warning'>, retries?: number, delayMs?: number, source?: string, transient?: boolean }

// Transport-level failures that a retry can recover from. Only used for idempotent writes (see dfRetry).
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'ERR_BAD_RESPONSE', 'ERR_NETWORK'])

const isTransient = (err: any): boolean => {
  const status = err?.status ?? err?.response?.status
  if (typeof status === 'number' && status >= 500 && status < 600) return true
  if (typeof err?.code === 'string' && TRANSIENT_CODES.has(err.code)) return true
  return /stream has been aborted|socket hang up|aborted/i.test(err?.message ?? '')
}

/**
 * Run an async call, retrying on HTTP 429 (Too Many Requests): data-fair rate-limits bursts, so we
 * pause and retry rather than failing the whole run. With `transient` (idempotent writes only) it
 * also retries network aborts (e.g. axios "stream has been aborted" when data-fair drops the
 * `_bulk_lines` response) and 5xx. `fn` is a thunk so the request is rebuilt on each attempt.
 */
export const withRetry429 = async <T>(fn: () => Promise<T>, opts: Retry429Opts = {}): Promise<T> => {
  const { log, retries = 3, delayMs = 10000, source = 'Data-Fair', transient = false } = opts
  let attempt = 0
  while (true) {
    try {
      return await fn()
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status
      const retryable = status === 429 || (transient && isTransient(err))
      if (!retryable || attempt >= retries) throw err
      attempt++
      const reason = status === 429 ? `429 reçu de ${source}` : `erreur réseau vers ${source}`
      if (log) await log.warning(`${reason} — pause ${delayMs / 1000}s avant nouvelle tentative (${attempt}/${retries})`)
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
}

/**
 * Run a data-fair write call with the retry (the worker never retries POST/PATCH).
 * `transient` must stay false for non-idempotent calls (dataset creation): a network abort after
 * the server applied the request would duplicate it.
 */
export const dfRetry = <T>(fn: () => Promise<T>, log?: Pick<LogFunctions, 'warning'>, transient = false): Promise<T> =>
  withRetry429(fn, { log, transient })

/** Axios hides the reason given by data-fair inside response.data; JSON.stringify(err) drops it. */
export const describeError = (err: any): string => {
  const detail = err.response?.data ?? err.data
  const body = typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : ''
  return body ? `${err.message} : ${body}` : err.message
}

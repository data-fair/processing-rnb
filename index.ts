import type { PrepareFunction, RunFunction } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from './types/processingConfig/index.ts'

/**
 * Prepare the processing config (triggered when the config is saved).
 * Validates the action-dependent fields.
 */
export const prepare: PrepareFunction<ProcessingConfig> = async (context) => {
  const prepare = (await import('./lib/prepare.ts')).default
  return prepare(context)
}

/**
 * Execute the processing (triggered when the processing is started).
 * First run imports the full national export, following runs apply the nightly diff.
 */
export const run: RunFunction<ProcessingConfig> = async (context) => {
  const { run } = await import('./lib/run.ts')
  return run(context)
}

/**
 * Function to stop the processing (triggered when the processing is stopped).
 * It is used to manage interruption and prevent incoherent state.
 * The run method should finish shortly after calling stop.
 */
export const stop = async () => {
  const { stop } = await import('./lib/run.ts')
  return stop()
}

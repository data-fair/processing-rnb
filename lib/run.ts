import type { RunFunction } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from '#types/processingConfig/index.ts'
import { resetStop, requestStop } from './utils.ts'

/**
 * Dispatch to the full national import (create), the nightly diff (update) or the targeted geometry
 * repair (repair).
 */
export const run: RunFunction<ProcessingConfig> = async (context) => {
  resetStop()
  if (context.processingConfig.datasetMode === 'create') {
    const { runFullImport } = await import('./full-import.ts')
    await runFullImport(context)
  } else if (context.processingConfig.datasetMode === 'repair') {
    const { runRepair } = await import('./repair.ts')
    await runRepair(context)
  } else {
    const { runDiff } = await import('./diff.ts')
    await runDiff(context)
  }
}

/** Sets the stop flag checked by the import/diff batch loops. */
export const stop = async () => { requestStop() }

import type { PrepareFunction } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from '#types/processingConfig/index.ts'

/**
 * The plugin has no secret: this only validates the fields that depend on the selected action, so
 * the two branches can share one form.
 */
const prepare: PrepareFunction<ProcessingConfig> = async ({ processingConfig, secrets }) => {
  if (processingConfig.datasetMode === 'create') {
    if (!processingConfig.datasetTitle) throw new Error('Titre du jeu de données à créer manquant.')
  } else if (processingConfig.datasetMode === 'update') {
    if (!processingConfig.dataset?.id) throw new Error('Jeu de données à mettre à jour manquant.')
  } else {
    throw new Error(`Action inconnue : "${processingConfig.datasetMode}".`)
  }

  return { processingConfig, secrets }
}

export default prepare

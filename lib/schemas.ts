import type { SchemaProperty } from './types.ts'

export const GEOMETRY_CONCEPT = 'https://purl.org/geojson/vocab#geometry'
export const RNB_ID_CONCEPT = 'https://rnb.gouv.fr/#ID-RNB'
export const DATE_CONCEPT = 'http://schema.org/Date'

/** Columns of the produced dataset, in the order they are written to the bulk CSV. */
export const RNB_COLUMNS = [
  'rnb_id',
  'point',
  'shape',
  'status',
  'ext_ids',
  'addresses_id',
  'validated_by',
  'modified_at'
] as const

export type RnbColumn = typeof RNB_COLUMNS[number]

/** Columns of a `_bulk_lines` payload: the operation, then every dataset column. */
export const BULK_COLUMNS: string[] = ['_action', ...RNB_COLUMNS]

/** Repair payloads only patch the geometry: the other columns are left untouched. */
export const PATCH_COLUMNS: string[] = ['_action', 'rnb_id', 'shape']

/**
 * Schema of the produced dataset. Text indexing is disabled on every raw JSON column: they are
 * machine values, indexing them would only inflate the Elasticsearch index.
 */
export const RNB_SCHEMA: SchemaProperty[] = [
  {
    key: 'rnb_id',
    title: 'ID-RNB',
    description: 'Identifiant unique et pérenne du bâtiment dans le RNB.',
    type: 'string',
    'x-refersTo': RNB_ID_CONCEPT,
    ignoreDetection: true
  },
  {
    key: 'point',
    title: 'Point',
    description: 'Localisation du bâtiment en WGS84, au format « latitude,longitude ».',
    type: 'string',
    ignoreDetection: true,
    'x-capabilities': { textAgg: false }
  },
  {
    key: 'shape',
    title: 'Contour',
    description: 'Enveloppe géométrique du bâtiment en WGS84, au format WKT.',
    type: 'string',
    'x-refersTo': GEOMETRY_CONCEPT,
    'x-capabilities': { textAgg: false }
  },
  {
    key: 'status',
    title: 'Statut',
    description: 'Statut physique du bâtiment.',
    type: 'string',
    'x-labels': {
      constructed: 'Construit',
      notUsable: 'Non utilisable',
      demolished: 'Démoli'
    },
    'x-capabilities': { textAgg: false }
  },
  {
    key: 'ext_ids',
    title: 'Identifiants externes',
    description: 'Identifiants du bâtiment dans la BDNB et la BD Topo (JSON).',
    type: 'string',
    'x-capabilities': { textStandard: false, textAgg: false, values: false }
  },
  {
    key: 'addresses_id',
    title: 'Identifiants BAN des adresses',
    description: 'Identifiants des adresses BAN rattachées au bâtiment (JSON).',
    type: 'string',
    'x-capabilities': { textStandard: false, textAgg: false, values: false }
  },
  {
    key: 'validated_by',
    title: 'Validé par',
    description: 'Contributeurs ayant validé ce bâtiment (JSON).',
    type: 'string',
    'x-capabilities': { textStandard: false, textAgg: false, values: false }
  },
  {
    key: 'modified_at',
    title: 'Date de modification',
    description: 'Date de la dernière modification du bâtiment connue du RNB.',
    type: 'string',
    format: 'date-time',
    'x-refersTo': DATE_CONCEPT
  }
]

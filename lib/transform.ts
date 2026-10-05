import type { RnbColumn } from './schemas.ts'
import { shapeToWkt, COORD_DECIMALS } from './geometry.ts'

export type BulkAction = 'createOrUpdate' | 'patch' | 'delete'
export type DatasetRow = Partial<Record<RnbColumn, string>> & { _action: BulkAction, rnb_id: string }

const POINT_FACTOR = 10 ** COORD_DECIMALS
const round = (value: string): string => String(Math.round(Number(value) * POINT_FACTOR) / POINT_FACTOR)

/** `SRID=4326;POINT(lon lat)` → `"lat,lon"` rounded, the format data-fair reads for a geopoint. */
export const ewktPointToLatLon = (value: string): string => {
  const match = /POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/i.exec(value || '')
  if (!match) return ''
  return `${round(match[2])},${round(match[1])}`
}

/** Export `addresses` column (full JSON objects) → JSON array of BAN address ids. */
export const addressesToIds = (value: string): string => {
  if (!value) return '[]'
  try {
    const addresses = JSON.parse(value)
    if (!Array.isArray(addresses)) return '[]'
    return JSON.stringify(addresses.map(address => address?.id).filter(Boolean))
  } catch {
    return '[]'
  }
}

/** PostgreSQL tstzrange `["2026-09-28 06:11:09.723095+00",)` → ISO 8601 date-time. */
export const sysPeriodToIso = (value: string): string => {
  const match = /^\["([^"]+)"/.exec(value || '')
  if (!match) return ''
  const date = new Date(match[1].replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'))
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

/** RNB diff `action` column → data-fair bulk action. Unknown actions are ignored. */
export const actionToBulkAction = (action: string): BulkAction | null => {
  switch ((action || '').trim()) {
    case 'create':
    case 'update':
      return 'createOrUpdate'
    case 'delete':
    case 'deactivate':
      return 'delete'
    default:
      return null
  }
}

/** One line of the national export (`;` separated) → one dataset row. */
export const exportRowToDatasetRow = (row: Record<string, string>): DatasetRow => ({
  _action: 'createOrUpdate',
  rnb_id: row.rnb_id || '',
  point: ewktPointToLatLon(row.point || ''),
  shape: shapeToWkt(row.shape || ''),
  status: row.status || '',
  ext_ids: row.ext_ids || '',
  addresses_id: addressesToIds(row.addresses || ''),
  validated_by: row.validated_by || '',
  modified_at: ''
})

/** One line of the diff CSV (`,` separated) → one dataset row, or null for an unknown action. */
export const diffRowToDatasetRow = (row: Record<string, string>): DatasetRow | null => {
  const action = actionToBulkAction(row.action)
  if (!action) return null
  const modifiedAt = sysPeriodToIso(row.sys_period || '')
  if (action === 'delete') return { _action: 'delete', rnb_id: row.rnb_id || '', modified_at: modifiedAt }
  return {
    _action: 'createOrUpdate',
    rnb_id: row.rnb_id || '',
    point: ewktPointToLatLon(row.point || ''),
    shape: shapeToWkt(row.shape || ''),
    status: row.status || '',
    ext_ids: row.ext_ids || '',
    addresses_id: row.addresses_id || '[]',
    validated_by: row.validated_by || '',
    modified_at: modifiedAt
  }
}

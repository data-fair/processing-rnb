import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  actionToBulkAction,
  addressesToIds,
  diffRowToDatasetRow,
  ewktPointToLatLon,
  ewktToWkt,
  exportRowToDatasetRow,
  sysPeriodToIso
} from '../lib/transform.ts'

test('ewktPointToLatLon converts EWKT lon/lat to data-fair lat,lon', () => {
  assert.equal(
    ewktPointToLatLon('SRID=4326;POINT(4.033645854904865 49.42990814620328)'),
    '49.42990814620328,4.033645854904865'
  )
  assert.equal(ewktPointToLatLon('SRID=4326;POINT(-4.116734211997037 48.00815045515884)'), '48.00815045515884,-4.116734211997037')
  assert.equal(ewktPointToLatLon(''), '')
  assert.equal(ewktPointToLatLon('garbage'), '')
})

test('ewktToWkt strips the SRID prefix', () => {
  assert.equal(ewktToWkt('SRID=4326;MULTIPOLYGON(((4.03 49.42)))'), 'MULTIPOLYGON(((4.03 49.42)))')
  assert.equal(ewktToWkt('POINT(1 2)'), 'POINT(1 2)')
  assert.equal(ewktToWkt(''), '')
})

test('addressesToIds keeps only the BAN ids', () => {
  const addresses = '[{"id": "72280_0175_00003", "street": "Rue A"}, {"id": "72280_0175_00004"}]'
  assert.equal(addressesToIds(addresses), '["72280_0175_00003","72280_0175_00004"]')
  assert.equal(addressesToIds('[]'), '[]')
  assert.equal(addressesToIds(''), '[]')
  assert.equal(addressesToIds('not json'), '[]')
})

test('sysPeriodToIso reads the lower bound of a tstzrange', () => {
  assert.equal(sysPeriodToIso('["2026-09-28 06:11:09.723095+00",)'), '2026-09-28T06:11:09.723Z')
  assert.equal(sysPeriodToIso('["2026-09-28 06:14:30.588823+00","2026-09-28 07:00:00+00")'), '2026-09-28T06:14:30.588Z')
  assert.equal(sysPeriodToIso(''), '')
})

test('actionToBulkAction maps the diff actions', () => {
  assert.equal(actionToBulkAction('create'), 'createOrUpdate')
  assert.equal(actionToBulkAction('update'), 'createOrUpdate')
  assert.equal(actionToBulkAction('delete'), 'delete')
  assert.equal(actionToBulkAction('deactivate'), 'delete')
  assert.equal(actionToBulkAction('merge'), null)
})

test('exportRowToDatasetRow builds a full row from the national export', () => {
  const row = exportRowToDatasetRow({
    rnb_id: 'ZPAXN7C4DPJE',
    point: 'SRID=4326;POINT(4.033645854904865 49.42990814620328)',
    shape: 'SRID=4326;MULTIPOLYGON(((4.03 49.42)))',
    status: 'constructed',
    ext_ids: '[{"id": "bdnb-bc-JQP9-7Y45-2XUR", "source": "bdnb"}]',
    addresses: '[{"id": "025410000B0348", "bdg_cover_ratio": 0.05}]',
    plots: '[{"id": "025410000B0348", "bdg_cover_ratio": 0.05}]',
    validated_by: '[]'
  })
  assert.deepEqual(row, {
    _action: 'createOrUpdate',
    rnb_id: 'ZPAXN7C4DPJE',
    point: '49.42990814620328,4.033645854904865',
    shape: 'MULTIPOLYGON(((4.03 49.42)))',
    status: 'constructed',
    ext_ids: '[{"id": "bdnb-bc-JQP9-7Y45-2XUR", "source": "bdnb"}]',
    addresses_id: '["025410000B0348"]',
    validated_by: '[]',
    modified_at: ''
  })
})

test('diffRowToDatasetRow maps create/update and delete rows', () => {
  assert.deepEqual(diffRowToDatasetRow({
    action: 'update',
    rnb_id: 'Y3AQWE8M2VV2',
    status: 'constructed',
    sys_period: '["2026-09-28 06:14:11.31343+00",)',
    point: 'SRID=4326;POINT(-4.116734211997037 48.00815045515884)',
    shape: 'SRID=4326;MULTIPOLYGON(((-4.11 48.00)))',
    addresses_id: '["29232_3760_00004"]',
    ext_ids: '[]',
    validated_by: '[]'
  }), {
    _action: 'createOrUpdate',
    rnb_id: 'Y3AQWE8M2VV2',
    point: '48.00815045515884,-4.116734211997037',
    shape: 'MULTIPOLYGON(((-4.11 48.00)))',
    status: 'constructed',
    ext_ids: '[]',
    addresses_id: '["29232_3760_00004"]',
    validated_by: '[]',
    modified_at: '2026-09-28T06:14:11.313Z'
  })

  assert.deepEqual(diffRowToDatasetRow({
    action: 'deactivate',
    rnb_id: 'XRHNX11HEQV3',
    sys_period: '["2026-09-28 06:11:09.723095+00",)'
  }), {
    _action: 'delete',
    rnb_id: 'XRHNX11HEQV3',
    modified_at: '2026-09-28T06:11:09.723Z'
  })

  assert.equal(diffRowToDatasetRow({ action: 'mystery', rnb_id: 'X' }), null)
})

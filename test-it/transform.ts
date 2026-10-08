import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  actionToBulkAction,
  addressesToIds,
  diffRowToDatasetRow,
  ewktPointToLatLon,
  exportRowToDatasetRow,
  sysPeriodToIso
} from '../lib/transform.ts'
import { shapeToWkt } from '../lib/geometry.ts'
import { GEOMETRY_CONCEPT, RNB_SCHEMA } from '../lib/schemas.ts'

// data-fair indexes a single geo column: only one schema property may carry a geo concept.
test('RNB_SCHEMA carries a single geo concept', () => {
  const geoConcepts = [
    'https://purl.org/geojson/vocab#geometry',
    'http://data.ign.fr/def/geometrie#Geometry',
    'http://www.w3.org/2003/01/geo/wgs84_pos#lat_long',
    'http://schema.org/latitude',
    'http://www.w3.org/2003/01/geo/wgs84_pos#lat',
    'http://schema.org/longitude',
    'http://www.w3.org/2003/01/geo/wgs84_pos#long',
    'http://data.ign.fr/def/geometrie#coordX',
    'http://data.ign.fr/def/geometrie#coordY'
  ]
  const geoColumns = RNB_SCHEMA.filter(p => p['x-refersTo'] && geoConcepts.includes(p['x-refersTo']))
  assert.deepEqual(geoColumns.map(p => p.key), ['shape'])
  assert.equal(RNB_SCHEMA.find(p => p.key === 'shape')?.['x-refersTo'], GEOMETRY_CONCEPT)
})

test('ewktPointToLatLon converts EWKT lon/lat to data-fair lat,lon, rounded to 6 decimals', () => {
  assert.equal(
    ewktPointToLatLon('SRID=4326;POINT(4.033645854904865 49.42990814620328)'),
    '49.429908,4.033646'
  )
  assert.equal(ewktPointToLatLon('SRID=4326;POINT(-4.116734211997037 48.00815045515884)'), '48.00815,-4.116734')
  assert.equal(ewktPointToLatLon(''), '')
  assert.equal(ewktPointToLatLon('garbage'), '')
})

test('shapeToWkt rounds coordinates and normalizes a valid polygon', () => {
  assert.equal(
    shapeToWkt('SRID=4326;MULTIPOLYGON(((4.031234567891 49.421234567891,4.04 49.42,4.04 49.43,4.03 49.43,4.031234567891 49.421234567891)))'),
    'POLYGON ((4.031235 49.421235, 4.04 49.42, 4.04 49.43, 4.03 49.43, 4.031235 49.421235))'
  )
  assert.equal(shapeToWkt('SRID=4326;POINT(4.033645854904865 49.42990814620328)'), 'POINT (4.033646 49.429908)')
  assert.equal(shapeToWkt(''), '')
  assert.equal(shapeToWkt('SRID=4326;MULTIPOLYGON(((4.03 49.42)))'), '')
})

// RNB building 348ZZBX2HQ32: kinked ring that ES refuses to tessellate and that data-fair's own
// @turf/unkink-polygon fallback leaves untouched. Rounding collapses this one; the output must be
// a simple (non self-intersecting) polygon.
test('shapeToWkt makes a kinked RNB polygon ES-indexable', () => {
  const kinked = 'SRID=4326;MULTIPOLYGON(((4.893202211385481 47.18635083919363,4.893181499759598 47.18636288480153,4.893125788678635 47.186318768600586,4.893087132435354 47.18634641670887,4.893140076480027 47.186386976006055,4.893202211385481 47.18635083919363)))'
  assert.equal(shapeToWkt(kinked), 'POLYGON ((4.893202 47.186351, 4.893181 47.186363, 4.893126 47.186319, 4.893087 47.186346, 4.89314 47.186387, 4.893202 47.186351))')
})

test('addressesToIds keeps only the address ids', () => {
  // national export format: the id is in `cle_interop_ban`
  const addresses = '[{"cle_interop_ban" : "IMB/01053/C/003B", "street_number" : "374"}, {"cle_interop_ban" : "01053_0750_00374", "street_rep" : null}]'
  assert.equal(addressesToIds(addresses), '["IMB/01053/C/003B","01053_0750_00374"]')
  // API format
  assert.equal(addressesToIds('[{"id": "72280_0175_00003", "street": "Rue A"}]'), '["72280_0175_00003"]')
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

// Real line of RNB_nat.csv (export of 2026-10-04), as parsed from the `;` separated file.
test('exportRowToDatasetRow builds a full row from the national export', () => {
  const row = exportRowToDatasetRow({
    rnb_id: 'DT73MF7NDE8M',
    point: 'SRID=4326;POINT(5.215758632846468 46.21084685132588)',
    shape: 'SRID=4326;MULTIPOLYGON(((5.21583483950653 46.21081834421106,5.215799145120098 46.21089831345784,5.215682731639923 46.21087535844071,5.21571835339785 46.21079358897399,5.21583483950653 46.21081834421106)))',
    status: 'constructed',
    ext_ids: '[{"id": "bdnb-bc-ACWM-JRV4-SY85", "source": "bdnb", "created_at": "2023-12-07T13:13:05.783459+00:00", "source_version": "2023_01"}]',
    addresses: '[{"cle_interop_ban" : "IMB/01053/C/003B", "street_number" : "374", "street_rep" : "", "street" : "rue de la chambiere", "city_zipcode" : "", "city_name" : "Bourg-en-Bresse"}, {"cle_interop_ban" : "01053_0750_00374", "street_number" : "374", "street_rep" : null, "street" : "rue de la chambière", "city_zipcode" : "01000", "city_name" : "Bourg-en-Bresse"}]',
    plots: '[{"id" : "01053000AB0301", "bdg_cover_ratio" : 0.9999497286428998}]',
    validated_by: '[]'
  })
  assert.deepEqual(row, {
    _action: 'createOrUpdate',
    rnb_id: 'DT73MF7NDE8M',
    point: '46.210847,5.215759',
    shape: 'POLYGON ((5.215835 46.210818, 5.215799 46.210898, 5.215683 46.210875, 5.215718 46.210794, 5.215835 46.210818))',
    status: 'constructed',
    ext_ids: '[{"id": "bdnb-bc-ACWM-JRV4-SY85", "source": "bdnb", "created_at": "2023-12-07T13:13:05.783459+00:00", "source_version": "2023_01"}]',
    addresses_id: '["IMB/01053/C/003B","01053_0750_00374"]',
    validated_by: '[]',
    modified_at: ''
  })
})

// An irreparable contour must not leave the line without any geometry: data-fair would skip its
// geo column and the building would vanish from the map. Fall back to the building point.
test('exportRowToDatasetRow falls back to the point when the contour cannot be repaired', () => {
  const row = exportRowToDatasetRow({
    rnb_id: 'S5CAKN8GTZSD',
    point: 'SRID=4326;POINT(-0.206002947992377 48.89836806844313)',
    shape: 'SRID=4326;MULTIPOLYGON(((4.03 49.42)))'
  })
  assert.equal(row.shape, 'POINT (-0.206003 48.898368)')
  assert.equal(row.point, '48.898368,-0.206003')
})

test('diffRowToDatasetRow maps create/update and delete rows', () => {
  assert.deepEqual(diffRowToDatasetRow({
    action: 'update',
    rnb_id: 'Y3AQWE8M2VV2',
    status: 'constructed',
    sys_period: '["2026-09-28 06:14:11.31343+00",)',
    point: 'SRID=4326;POINT(-4.116734211997037 48.00815045515884)',
    shape: 'SRID=4326;MULTIPOLYGON(((-4.11 48.00,-4.1 48.00,-4.1 48.01,-4.11 48.01,-4.11 48.00)))',
    addresses_id: '["29232_3760_00004"]',
    ext_ids: '[]',
    validated_by: '[]'
  }), {
    _action: 'createOrUpdate',
    rnb_id: 'Y3AQWE8M2VV2',
    point: '48.00815,-4.116734',
    shape: 'POLYGON ((-4.11 48, -4.1 48, -4.1 48.01, -4.11 48.01, -4.11 48))',
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

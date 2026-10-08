/**
 * Ambient declaration for @terraformer/wkt, which ships no types of its own.
 * Only the two converters lib/geometry.ts uses are described.
 */
declare module '@terraformer/wkt' {
  export function wktToGeoJSON (wkt: string): { type: string, coordinates?: any, geometries?: any[] }
  export function geojsonToWKT (geometry: { type: string, coordinates?: any, geometries?: any[] }): string
}

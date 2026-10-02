export interface SchemaProperty {
  key: string
  title: string
  description?: string
  type: string
  format?: string
  separator?: string
  ignoreDetection?: boolean
  'x-refersTo'?: string
  'x-labels'?: Record<string, string>
  'x-capabilities'?: Record<string, boolean>
}

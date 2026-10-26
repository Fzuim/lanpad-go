export type NetworkAddress = {
  iface: string
  address: string
  url: string
}

export type NetworkInfo = {
  primary: string
  primaryAddress: string
  addresses: NetworkAddress[]
}

export type DocMeta = {
  id: string
  title: string
  created_at: number
  updated_at: number
  last_editor: string | null
  online: number
  url?: string
}

export type UserInfo = {
  name: string
  color: string
}

export type PresenceUser = {
  clientId: number
  name: string
  color: string
  isSelf: boolean
}

export type AssetResult = {
  url: string
  width: number | null
  height: number | null
  mime: string
}

export type AttachmentResult = {
  url: string
  name: string
  size: number
  mime: string
  kind: 'file' | 'image'
  ext: string
}

export type DocVersion = {
  id: number
  created_at: number
  title: string
  size: number
  sha256: string
}

export type DocVersionDetail = DocVersion & {
  /** Base64-encoded Yjs V1 update. */
  state: string
}

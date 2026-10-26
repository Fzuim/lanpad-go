import type {
  AssetResult,
  AttachmentResult,
  DocMeta,
  DocVersion,
  DocVersionDetail,
  NetworkInfo,
} from './types'

export class ApiError extends Error {
  status: number
  code: string

  constructor(message: string, status: number, code = 'ERROR') {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  const data = (await response.json().catch(() => null)) as
    | { error?: { code?: string; message?: string } }
    | T
    | null
  if (!response.ok) {
    const error =
      typeof data === 'object' && data !== null && 'error' in data ? data.error : undefined
    throw new ApiError(error?.message || `请求失败（${response.status}）`, response.status, error?.code)
  }
  return data as T
}

export async function getNetwork(): Promise<NetworkInfo> {
  return request<NetworkInfo>('/api/network')
}

export async function getDocs(base?: string): Promise<{ docs: DocMeta[] }> {
  const query = base ? `?base=${encodeURIComponent(base)}` : ''
  return request<{ docs: DocMeta[] }>(`/api/docs${query}`)
}

export async function createDoc(title?: string): Promise<DocMeta> {
  return request<DocMeta>('/api/docs', {
    method: 'POST',
    body: JSON.stringify({ title }),
  })
}

export async function getDoc(id: string): Promise<DocMeta> {
  return request<DocMeta>(`/api/docs/${id}`)
}

export async function deleteDoc(id: string, hostKey: string): Promise<void> {
  await request<{ ok: true }>(`/api/docs/${id}`, {
    method: 'DELETE',
    headers: { 'X-Host-Key': hostKey },
  })
}

export async function uploadAsset(
  docId: string,
  file: File,
  width: number | null,
  height: number | null,
): Promise<AssetResult> {
  const form = new FormData()
  form.append('file', file)
  if (width) form.append('width', String(width))
  if (height) form.append('height', String(height))
  return request<AssetResult>(`/api/docs/${docId}/assets`, {
    method: 'POST',
    body: form,
  })
}

export async function uploadAttachment(
  docId: string,
  file: File,
): Promise<AttachmentResult> {
  const form = new FormData()
  form.append('file', file)
  return request<AttachmentResult>(`/api/docs/${docId}/attachments`, {
    method: 'POST',
    body: form,
  })
}

export async function getVersions(docId: string): Promise<{ versions: DocVersion[] }> {
  return request<{ versions: DocVersion[] }>(`/api/docs/${docId}/versions`)
}

export async function getVersion(docId: string, versionId: number): Promise<DocVersionDetail> {
  return request<DocVersionDetail>(`/api/docs/${docId}/versions/${versionId}`)
}

export async function snapshotVersion(
  docId: string,
): Promise<{ created: boolean; version?: DocVersion }> {
  return request<{ created: boolean; version?: DocVersion }>(`/api/docs/${docId}/versions`, {
    method: 'POST',
  })
}

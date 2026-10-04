// Descriptor access is checked on every use, including a cached adjacent page.
// Only private blobs enter memory; expiring API URLs never become <img> src.
export function createPageImageCache({ fetcher = fetch, urls = URL, now = Date.now } = {}) {
  const entries = new Map()
  const pending = new Map()
  let generation = 0
  function clear() {
    generation++
    for (const entry of entries.values()) urls.revokeObjectURL(entry.url)
    entries.clear()
    pending.clear()
  }
  async function load(base, number, options) {
    const current = generation
    const response = await fetcher(`${base}/images/${number}/descriptor`, options)
    if (!response.ok) throw new Error('页面图片不可用')
    const descriptor = await response.json()
    if (current !== generation) throw new DOMException('预览已切换', 'AbortError')
    if (!descriptor.assetId || !descriptor.url || !Number.isFinite(Date.parse(descriptor.expiresAt)) || Date.parse(descriptor.expiresAt) <= now() || !Number.isInteger(descriptor.width) || !Number.isInteger(descriptor.height) || descriptor.width < 1 || descriptor.height < 1 || descriptor.width > 2048 || descriptor.height > 2048) throw new Error('页面图片信息无效')
    // Keep auth headers on the trusted API origin and task path only.
    const assetURL = new URL(descriptor.url, base)
    const expected = new URL(`${base}/images/${number}/asset`)
    if (assetURL.origin !== expected.origin || assetURL.pathname !== expected.pathname) throw new Error('页面图片地址无效')
    const previous = entries.get(number)
    if (previous?.assetId === descriptor.assetId && previous.expires > now()) return previous
    if (pending.get(number)?.assetId === descriptor.assetId) return pending.get(number).promise
    const promise = (async () => {
      const asset = await fetcher(assetURL.href, options)
      if (!asset.ok || !asset.headers.get('content-type')?.startsWith('image/webp')) throw new Error('页面图片加载失败')
      const blob = await asset.blob()
      if (current !== generation) throw new DOMException('预览已切换', 'AbortError')
      if (Date.parse(descriptor.expiresAt) <= now()) throw new Error('页面图片链接已过期')
      const old = entries.get(number)
      if (old) urls.revokeObjectURL(old.url)
      const entry = { ...descriptor, url: urls.createObjectURL(blob), expires: Date.parse(descriptor.expiresAt) }
      entries.set(number, entry)
      return entry
    })()
    pending.set(number, { assetId: descriptor.assetId, promise })
    try { return await promise } finally {
      if (pending.get(number)?.promise === promise) pending.delete(number)
    }
  }
  return { load, clear }
}

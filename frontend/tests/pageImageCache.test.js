import test from 'node:test'
import assert from 'node:assert/strict'
import { createPageImageCache } from '../src/lib/pageImageCache.js'

const base = 'https://api.example.com/api/fangji/pages/task'
function fixture() {
  let now = 1000, created = 0
  const calls = [], revoked = []
  const descriptors = new Map()
  const cache = createPageImageCache({ now: () => now, urls: { createObjectURL: () => `blob:${++created}`, revokeObjectURL: u => revoked.push(u) }, fetcher: async (url, options) => {
    calls.push({ url, options })
    const n = Number(url.match(/images\/(\d+)/)[1])
    if (url.endsWith('/descriptor')) return Response.json(descriptors.get(n) || { assetId: `page-${n}`, url: `/api/fangji/pages/task/images/${n}/asset?key=short`, width: 100, height: 200, expiresAt: new Date(5000).toISOString() })
    return new Response('webp', { headers: { 'Content-Type': 'image/webp' } })
  } })
  return { cache, calls, revoked, descriptors, advance: () => { now = 5000 } }
}

test('adjacent blobs are reused only after rechecking live descriptor permission', async () => {
  const f = fixture(), options = { headers: { Authorization: 'test' }, cache: 'no-store' }
  const first = await f.cache.load(base, 2, options)
  await f.cache.load(base, 3, options)
  assert.equal(await f.cache.load(base, 2, options), first)
  assert.equal(f.calls.filter(c => c.url.includes('/asset')).length, 2)
  assert.equal(f.calls.filter(c => c.url.endsWith('/descriptor')).length, 3)
  assert.ok(f.calls.every(c => c.options === options))
  f.cache.clear()
  assert.deepEqual(f.revoked, ['blob:1', 'blob:2'])
})

test('expired metadata and cross-origin URLs are refused before sending credentials', async () => {
  const f = fixture()
  await f.cache.load(base, 2, {})
  f.advance()
  await assert.rejects(f.cache.load(base, 2, {}), /信息无效/)
  f.descriptors.set(3, { assetId: 'evil', url: 'https://other.example/asset', width: 10, height: 10, expiresAt: new Date(9000).toISOString() })
  await assert.rejects(f.cache.load(base, 3, {}), /地址无效/)
  assert.equal(f.calls.filter(c => c.url.includes('/asset')).length, 1)
})

test('clearing during a fetch cannot publish a blob from a previous task/user', async () => {
  let finish
  const cache = createPageImageCache({ fetcher: () => new Promise(resolve => { finish = resolve }) })
  const pending = cache.load(base, 2, {})
  cache.clear()
  finish(Response.json({}))
  await assert.rejects(pending, { name: 'AbortError' })
})

test('simultaneous preload and navigation fetch the asset once', async () => {
  const f = fixture()
  const [a, b] = await Promise.all([f.cache.load(base, 2, {}), f.cache.load(base, 2, {})])
  assert.equal(a, b)
  assert.equal(f.calls.filter(c => c.url.includes('/asset')).length, 1)
})

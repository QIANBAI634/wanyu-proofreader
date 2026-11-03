import test from 'node:test'
import assert from 'node:assert/strict'

import {
  flushReturnQueue,
  loadQueueMode,
  loadReturnQueue,
  returnQueueKey,
  saveQueueMode,
  saveReturnQueue
} from '../src/lib/returnQueue.js'

function memoryStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  }
}

const item = (pageId, reason = 'text_mismatch') => ({ pageId, reason, basis: `${pageId} 对不上` })

test('keeps the return queue and queue mode per user', () => {
  const storage = memoryStorage()
  saveReturnQueue(storage, [item('page-a')], 'user-a')
  saveReturnQueue(storage, [item('page-b'), item('page-c')], 'user-b')
  saveQueueMode(storage, true, 'user-a')

  assert.deepEqual(loadReturnQueue(storage, 'user-a'), [item('page-a')])
  assert.deepEqual(loadReturnQueue(storage, 'user-b'), [item('page-b'), item('page-c')])
  assert.equal(loadQueueMode(storage, 'user-a'), true)
  assert.equal(loadQueueMode(storage, 'user-b'), false)
  assert.notEqual(returnQueueKey('user-a'), returnQueueKey('user-b'))
})

test('switching accounts never reads the previous account queue', () => {
  const storage = memoryStorage()
  saveReturnQueue(storage, [item('page-a')], 'user-a')
  saveQueueMode(storage, true, 'user-a')

  assert.deepEqual(loadReturnQueue(storage, 'user-b'), [])
  assert.equal(loadQueueMode(storage, 'user-b'), false)
})

test('drops malformed entries and ignores missing identity', () => {
  const storage = memoryStorage()
  storage.setItem(returnQueueKey('user-a'), JSON.stringify([
    item('page-a'),
    { pageId: 42, reason: 'text_mismatch' },
    { pageId: 'page-b' },
    null
  ]))

  assert.deepEqual(loadReturnQueue(storage, 'user-a'), [item('page-a')])
  assert.deepEqual(loadReturnQueue(storage, ''), [])
  assert.deepEqual(loadReturnQueue(null, 'user-a'), [])
})

test('a partial failure leaves only the failed item for the next retry', async () => {
  const calls = []
  const submit = async (entry) => {
    calls.push(entry.pageId)
    if (entry.pageId === 'page-b') throw Object.assign(new Error('offline'), { status: 0 })
  }

  const first = await flushReturnQueue([item('page-a'), item('page-b')], submit, (error) => error.status)
  assert.deepEqual(calls, ['page-a', 'page-b'])
  assert.deepEqual(first.remaining.map((entry) => entry.pageId), ['page-b'])
  assert.equal(first.failedCount, 1)

  const second = await flushReturnQueue(first.remaining, async (entry) => {
    calls.push(`retry:${entry.pageId}`)
  }, (error) => error.status)
  assert.deepEqual(calls, ['page-a', 'page-b', 'retry:page-b'])
  assert.deepEqual(second.remaining, [])
  assert.equal(second.failedCount, 0)
})

test('drops items the server says are no longer returnable (400/403/404)', async () => {
  const statuses = { 'page-400': 400, 'page-403': 403, 'page-404': 404 }
  const result = await flushReturnQueue(
    Object.keys(statuses).map((pageId) => item(pageId)),
    async (entry) => { throw Object.assign(new Error('gone'), { status: statuses[entry.pageId] }) },
    (error) => error.status
  )

  assert.deepEqual(result.remaining, [])
  assert.equal(result.failedCount, 0)
})

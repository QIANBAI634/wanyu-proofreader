import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// #234 验收第 5 条的后半句：「重算进行中按钮禁用，重复点击不并发触发」。
// 模板上的 `:disabled="assistBusy"` 只挡得住鼠标，挡不住脚本或双击的竞态，
// 而这两个接口是同步的——一次请求会把整个 PocketBase 的 hooks 线程占住，
// 并发两次就是 issue 里那句"duration_ms 翻倍吃掉管理员"。
// 所以这里不看模板字符串，直接把处理函数**取出来执行**：
// 数它到底调了几次服务，比断言它"写着 disabled"更接近那条验收。
const source = readFileSync(new URL('../src/views/admin/ProjectDetailView.vue', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n')

function handler(name) {
  const match = source.match(new RegExp(`async function ${name}\\(\\) \\{[\\s\\S]*?\\n\\}\\n`))
  assert.ok(match, `找不到 ${name}：这个测试与视图脱钩了，它守的那条验收也就没人守`)
  return match[0]
}

// 一个"永远不 resolve"的请求，用来把界面钉在"进行中"这一帧上。
function pending() {
  let release
  const promise = new Promise((resolve) => { release = resolve })
  return { promise, release }
}

function context({ service }) {
  const refs = {
    assistBusy: { value: false },
    assistError: { value: '' },
    assistRuns: { value: {} },
    assistPagesScanned: { value: null },
    assistNotice: { value: '' },
    assistPage: { value: 3 }
  }
  const bindings = {
    ...refs,
    projectId: 'p1',
    recomputeProjectFindings: service,
    recomputeProjectIdentity: service,
    recomputeNotice: () => 'notice',
    loadAssistFindings: async () => {}
  }
  const body = (name) => handler(name).replace(`async function ${name}() {`, 'return async function () {')
  return {
    refs,
    // new Function(...) 的返回值是**处理函数本身**，还要再调一次才算真的跑起来。
    run: (name) => new Function(...Object.keys(bindings), body(name))(...Object.values(bindings))()
  }
}

for (const name of ['runFindingsRecompute', 'runIdentityRecompute']) {
  test(`${name}：进行中重复点击不得再发第二次请求，结束后必须解锁`, async () => {
    const gate = pending()
    let calls = 0
    const { refs, run } = context({ service: async () => { calls += 1; return gate.promise } })
    const first = run(name)
    await Promise.resolve()
    assert.equal(refs.assistBusy.value, true, `${name} 没有在请求期间置 busy`)
    const second = run(name)
    // 计数必须在 await 之前读：服务调用发生在处理函数第一个 await 之前，此刻 calls 已是终值。
    // 反过来先 await 第二次调用，守卫一旦被删掉，这条测试不会红，而是挂在那个永不 resolve 的 gate 上。
    assert.equal(calls, 1, `busy 期间又发了一次请求（calls=${calls}）`)
    await second
    gate.release({ pages: 2 })
    await first
    assert.equal(refs.assistBusy.value, false, `${name} 跑完之后没有解锁，按钮会永久灰着`)
    assert.equal(refs.assistPage.value, 1, '重算之后没有回到第 1 页')
    assert.notEqual(refs.assistNotice.value, '', '成功路径没有给出摘要')
  })

  test(`${name}：请求失败也要解锁，否则整个区块被一次网络抖动永久禁用`, async () => {
    const { refs, run } = context({ service: async () => { throw new Error('boom') } })
    await run(name)
    assert.equal(refs.assistBusy.value, false, '失败后 busy 没释放')
    assert.match(refs.assistError.value, /boom/)
  })
}

test('两个重算按钮共用同一个 busy，跨行与列级不许并行打满同一个同步接口', async () => {
  const gate = pending()
  let calls = 0
  const { refs, run } = context({ service: async () => { calls += 1; return gate.promise } })
  const findings = run('runFindingsRecompute')
  await Promise.resolve()
  const identity = run('runIdentityRecompute')
  assert.equal(calls, 1, '跨行重算没被同一个 busy 挡住')
  await identity
  gate.release({ pages: 2 })
  await findings
  assert.equal(refs.assistBusy.value, false)
})

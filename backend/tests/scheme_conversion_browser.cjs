// #190 的界面证据：管理端的「拼音归一」区块三态——配置缺失、跑完的汇总、复核队列。
//
// 与 assist_browser.cjs 同一套做法：静态资源从 frontend/dist 取，**/api/* 一律转发给
// 真实的 harness 服务端**，所以截图里的数字来自真库真引擎，不是 mock。
// 由 scheme_conversion_browser_integration.mjs 通过环境变量驱动；缺 playwright 或
// 构建产物时报错退出，绝不静默产出一张"看起来对"的空图。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

const fixture = JSON.parse(fs.readFileSync(process.env.SCHEME_BROWSER_FIXTURE))
const dist = path.resolve(__dirname, '../../frontend/dist')
const csp = fs.readFileSync(path.resolve(__dirname, '../../frontend/nginx.conf'), 'utf8')
  .match(/add_header Content-Security-Policy "([^"]+)"/)[1]
const out = process.env.SCHEME_BROWSER_OUTPUT || path.resolve(__dirname, '../../output/playwright/scheme-conversion')
assert.ok(fs.existsSync(path.join(dist, 'index.html')),
  '需要先构建前端（cd frontend && npm run build），否则截图会是空白页')

const shots = []
async function shoot (page, name) {
  const file = path.join(out, `${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  assert.ok(fs.existsSync(file) && fs.statSync(file).size > 4096, `截图为空：${file}`)
  shots.push([name, fs.statSync(file).size])
}

// 套件自己登录的那个管理员，直接对服务端说话。用在「把剩下的 AMBIGUOUS 清空、
// 只剩那一条 UNSUPPORTED」这一步：不是为了抄近路，而是**界面路径本身**要的
// 前置条件（还剩 11 条时界面没有「只剩暂未支持」这一态可看）。
async function api (p, { method = 'GET', body, expected = 200 } = {}) {
  const response = await fetch(fixture.base + p, {
    method,
    headers: { Authorization: fixture.manager.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const raw = await response.text()
  assert.equal(response.status, expected, `${method} ${p}: ${raw}`)
  return raw ? JSON.parse(raw) : null
}

async function session (browser, auth) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 300)}`) })
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url().slice(0, 140)}`) })
  await page.route('**/*', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    assert.equal(url.origin, 'http://localhost')
    if (url.pathname.startsWith('/api/')) {
      const headers = { ...req.headers() }
      delete headers.host
      delete headers['content-length']
      delete headers.authorization
      if (auth.token) headers.Authorization = auth.token
      const res = await fetch(fixture.base + url.pathname + url.search, {
        method: req.method(),
        headers,
        body: req.method() === 'GET' || req.method() === 'HEAD' ? undefined : (req.postDataBuffer() || undefined)
      })
      const body = Buffer.from(await res.arrayBuffer())
      if (res.status >= 400) {
        // 失败时把服务端的话打出来：页面只会渲染一句「读取……失败」，
        // 真正的理由（哪个参数、哪个字段）在响应体里，不打出来就只能猜。
        console.error(`API ${req.method()} ${url.pathname}${url.search} -> ${res.status}\n${body.toString('utf8').slice(0, 600)}`)
      }
      const responseHeaders = Object.fromEntries(res.headers)
      delete responseHeaders['content-length']
      delete responseHeaders['content-encoding']
      return route.fulfill({ status: res.status, headers: responseHeaders, body })
    }
    const target = path.resolve(dist, '.' + url.pathname)
    if (fs.existsSync(target) && fs.statSync(target).isFile()) return route.fulfill({ path: target })
    if (/\.(js|css|png|jpg|svg|woff2?|map|ico)$/i.test(url.pathname)) return route.fulfill({ status: 404, body: '' })
    return route.fulfill({ path: path.join(dist, 'index.html'), headers: { 'Content-Security-Policy': csp } })
  })
  await page.addInitScript((a) => {
    if (a && a.token) localStorage.setItem('pocketbase_auth', JSON.stringify({ token: a.token, record: a.record, model: a.record }))
  }, auth)
  page.__errors = errors
  return page
}

const schemeSection = (page) => page.locator('section', { has: page.locator('h2', { hasText: '拼音归一' }) }).first()

async function openProject (page, projectId) {
  await page.goto(`http://localhost/admin/projects/${projectId}`)
  await schemeSection(page).waitFor({ timeout: 60000 })
  await schemeSection(page).scrollIntoViewIfNeeded()
  await page.waitForTimeout(1500)
}

;(async () => {
  const browser = await chromium.launch({
    headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {})
  })
  try {
    fs.mkdirSync(out, { recursive: true })

    // 「本实例没有配置规则目录」那一态不在这里截：整个进程只有一个规则目录，
    // 造不出第二个配置。它由 scheme_conversion_test.go 的
    // TestLoadSchemeRegistryWithoutADirectoryIsALegalState 与前端 lib 的单测覆盖。
    // ---------- 2. 跑完的汇总 + 复核队列 ----------
    const manager = await session(browser, fixture.manager)
    await openProject(manager, fixture.project.id)
    const text = await schemeSection(manager).innerText()
    // 汇总是「最近一次转换」那一刻的结论，**不**随复核队列变短。这里按徽章文本取，
    // 不按整段文字取：队列的筛选按钮上也有「需人工确认」「暂未支持」四个字，
    // 整段匹配会让这条断言被按钮喂饱。
    const summaryBadges = await schemeSection(manager).locator('.badge').allInnerTexts()
    for (const label of ['共处理', '自动确定', '需人工确认', '暂未支持']) {
      assert.ok(summaryBadges.some((one) => one.startsWith(`${label} · `)),
        `汇总缺「${label}」这一行：${JSON.stringify(summaryBadges)}`)
    }
    assert.ok(summaryBadges.includes('需人工确认 · 12'), `汇总数字与夹具不符：${JSON.stringify(summaryBadges)}`)
    // 队列默认合并两种状态（AMBIGUOUS + UNSUPPORTED）：12 + 1。只列 AMBIGUOUS 的话，
    // 那 1 条「暂未支持」没有任何人工入口——机器判不出来，人也就永远给不了结论。
    assert.match(text, /共 13 条待复核/, `队列要合并两种待复核状态，并说清一共有多少条：${text.slice(0, 2000)}`)
    // 「原值（转换时）」而不是「原值」：快照下来的那个值才是结论针对的对象，
    // 校对后来改过那一格也不该悄悄改变它。
    assert.match(text, /原值（转换时）/, '复核队列要显示转换时的原值')
    assert.match(text, /候选/, '复核队列要显示候选解释')
    // 规则文件自己声明能不能跑真实作业，界面必须在按钮之前把这句话画出来。临时规则
    // 目录里两份文件都在（见 harness.write_scheme_adapters）：可运行副本 + 仓库夹具，
    // 所以这一屏上「仅测试」和「能用」两种选项同时在场——只截到其中一种的话，
    // 这条断言分不清「标记正确」与「给所有方案都盖了个章」。
    assert.match(text, /仅测试/, '选择器要标出声明为 test 的方案')
    assert.match(text, /拒绝用它创建真实转换作业/, '要说明标了「仅测试」意味着什么，而不是只贴一个标签')
    const optionTexts = await schemeSection(manager).locator('select option').allInnerTexts()
    assert.ok(optionTexts.some((one) => !/仅测试/.test(one)), `不能所有方案都被标成仅测试：${JSON.stringify(optionTexts)}`)
    const pager = schemeSection(manager).getByRole('navigation', { name: '复核队列分页' })
    assert.match(await pager.innerText(), /第 1 \/ 2 页/, '13 条待复核、每页 10 条，翻页控件必须出现')
    await shoot(manager, 'scheme-summary-and-queue')

    // ---------- 2b. 队列翻页：第二页是真的另一批条目，不是同一页换个页码 ----------
    const firstPageRows = await schemeSection(manager).locator('.assist-row strong').allInnerTexts()
    assert.equal(firstPageRows.length, 10, `一页 10 条：${JSON.stringify(firstPageRows)}`)
    await pager.getByRole('button', { name: '下一页' }).click()
    await manager.waitForTimeout(1500)
    assert.match(await pager.innerText(), /第 2 \/ 2 页/, '翻到第二页后页码要跟着走')
    const secondPageRows = await schemeSection(manager).locator('.assist-row strong').allInnerTexts()
    assert.equal(secondPageRows.length, 3, `第二页是剩下的 3 条：${JSON.stringify(secondPageRows)}`)
    for (const label of secondPageRows) {
      assert.ok(!firstPageRows.includes(label), `第二页不得重复第一页的条目：${label}`)
    }
    await shoot(manager, 'scheme-review-page-two')
    await pager.getByRole('button', { name: '上一页' }).click()
    await manager.waitForTimeout(1500)
    assert.match(await pager.innerText(), /第 1 \/ 2 页/, '回退到第一页')

    // ---------- 3. 人工结论：填完依据才可提交 ----------
    // 挑一条「需人工确认」的：队列按页码排序，第一条恰好是那条「暂未支持」（第 3 条），
    // 拿它做这一步会让「候选解释」的断言落空，也把两种状态的界面路径混成一条。
    const row = schemeSection(manager).locator('.assist-row', { hasText: '需人工确认' }).first()
    const decidedLabel = await row.locator('strong').innerText()
    const confirm = row.getByRole('button', { name: '确认结论' })
    assert.equal(await confirm.isDisabled(), true, '原值与依据都空时不该能提交')
    await row.getByLabel('统一方案的写法').fill('gu533')
    assert.equal(await confirm.isDisabled(), true, '只有原值、没有依据时仍然不该能提交')
    await row.getByLabel('依据（必填）').fill('对照原书凡例，n 在 k 后作 u')
    await shoot(manager, 'scheme-review-draft')
    await confirm.click()
    await manager.waitForTimeout(1500)
    const after = await schemeSection(manager).innerText()
    assert.match(after, /已复核/, `提交后应回显结论：${after.slice(0, 300)}`)
    // 复核一条、队列短一条：这条断言同时挡住「界面显示成功但队列没变」和反过来。
    assert.match(after, /共 12 条待复核/, `提交后总数要跟着少一条：${after.slice(0, 400)}`)
    const remaining = await schemeSection(manager).locator('.assist-row strong').allInnerTexts()
    assert.ok(!remaining.includes(decidedLabel), `已复核的条目不该再留在队列里：${decidedLabel}`)
    await shoot(manager, 'scheme-review-done')

    // ---------- 4. 只剩「暂未支持」时的界面路径 ----------
    // 把剩下的 AMBIGUOUS 全部经 API 结掉，队列里就只剩那一条 UNSUPPORTED。这正是
    // Codex 指出的那一屏：队列若是「只查 AMBIGUOUS」，这里会显示「当前没有待复核的条目」，
    // 而汇总里明明还有 1 条「暂未支持」——一条永远没有人能处理其结论的条目。
    const leftover = await api(
      `/api/fangji/projects/${fixture.project.id}/normalizations?status=AMBIGUOUS&perPage=100`)
    assert.equal(leftover.items.length, 11, `界面复核掉一条后应剩 11 条 AMBIGUOUS：${leftover.items.length}`)
    for (const item of leftover.items) {
      const tone = (item.source_pronunciation.match(/\d+/) || ['533'])[0]
      await api(`/api/fangji/pages/${item.id}/normalization`, {
        method: 'POST',
        body: {
          canonical_pronunciation: `gu${tone}`,
          basis: '清空复核队列，用于验证只剩「暂未支持」时仍有界面入口'
        }
      })
    }

    await manager.reload()
    await schemeSection(manager).waitFor({ timeout: 60000 })
    await manager.waitForTimeout(1500)
    const onlyUnsupported = await schemeSection(manager).innerText()
    assert.match(onlyUnsupported, /共 1 条待复核/, `清空 AMBIGUOUS 后应只剩那 1 条 UNSUPPORTED：${onlyUnsupported.slice(0, 400)}`)
    assert.doesNotMatch(onlyUnsupported, /当前没有待复核的条目/, '还有一条暂未支持时不得显示「没有待复核」')
    const unsupportedRow = schemeSection(manager).locator('.assist-row').first()
    const unsupportedText = await unsupportedRow.innerText()
    assert.match(unsupportedText, /暂未支持/, `剩下的这一条要标出状态：${unsupportedText}`)
    assert.match(unsupportedText, /第 3 条/, `剩下的应是被规则接不住的那一条：${unsupportedText}`)
    assert.match(unsupportedText, /ma533/, `原值应是转换时快照的 ma533：${unsupportedText}`)
    await unsupportedRow.scrollIntoViewIfNeeded()
    await shoot(manager, 'scheme-review-unsupported')

    // 筛到「需人工确认」是空的时候，空态要说的是哪一种空——不能拿一句笼统的
    // 「没有待复核」把「暂未支持」也一起说没了。
    await schemeSection(manager).getByRole('button', { name: '需人工确认', exact: true }).click()
    await manager.waitForTimeout(1500)
    const ambiguousEmpty = await schemeSection(manager).innerText()
    assert.match(ambiguousEmpty, /当前没有「需人工确认」的条目/, `筛选空态要说清是哪一种空：${ambiguousEmpty.slice(0, 300)}`)
    await schemeSection(manager).getByRole('button', { name: '全部待复核' }).click()
    await manager.waitForTimeout(1500)

    // UNSUPPORTED 也要能真的收下结论——「给得出入口」不是画一个按钮就算。
    const unsupported = schemeSection(manager).locator('.assist-row').first()
    await unsupported.getByLabel('统一方案的写法').fill('be533')
    await unsupported.getByLabel('依据（必填）').fill('m 在凡例里没有常规对应，按原书记音整体归入 b')
    await unsupported.getByRole('button', { name: '确认结论' }).click()
    await manager.waitForTimeout(1500)
    const cleared = await schemeSection(manager).innerText()
    assert.match(cleared, /当前没有待复核的条目/, `收下最后一条后队列才该空：${cleared.slice(0, 400)}`)

    for (const [page, label] of [[manager, 'manager']]) {
      assert.deepEqual(page.__errors, [], `${label} 页面出现错误：${JSON.stringify(page.__errors.slice(0, 5))}`)
    }
    for (const [name, size] of shots) console.log(`screenshot ${name}.png ${size} bytes`)
  } finally {
    await browser.close()
  }
})().catch((error) => { console.error(error); process.exit(1) })

// #172 质量状态的界面证据：管理端汇总、筛选、标注对话框的三条关键路径
// （正常 / 依据必填 / 服务端拒绝）与一份空态。
//
// 与 assist_browser.cjs 同一套做法：静态资源从 frontend/dist 取，**/api/* 一律转发给
// 真实的 harness 服务端**，所以截图里的数字来自真库真判据，不是 mock。
// 由 quality_state_browser_integration.mjs 通过环境变量驱动；缺 playwright 或构建产物时报错退出，
// 绝不静默产出一张"看起来对"的空图。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

const fixture = JSON.parse(fs.readFileSync(process.env.QUALITY_BROWSER_FIXTURE))
const dist = path.resolve(__dirname, '../../frontend/dist')
const csp = fs.readFileSync(path.resolve(__dirname, '../../frontend/nginx.conf'), 'utf8')
  .match(/add_header Content-Security-Policy "([^"]+)"/)[1]
const out = process.env.QUALITY_BROWSER_OUTPUT || path.resolve(__dirname, '../../output/playwright/quality-state')
assert.ok(fs.existsSync(path.join(dist, 'index.html')),
  '需要先构建前端（cd frontend && npm run build），否则截图会是空白页')

const shots = []
async function shoot (page, name) {
  const file = path.join(out, `${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  assert.ok(fs.existsSync(file) && fs.statSync(file).size > 4096, `截图为空：${file}`)
  shots.push([name, fs.statSync(file).size])
}

async function session (browser, auth) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const errors = []
  // 有一条 4xx 是**证据本身**：第 4 步故意对同一行再标一次同一个状态，服务端按
  // 「同值写入会刷新审计三列」拒绝。只豁免这一条 URL + 状态码，其余任何非 2xx
  // 仍然一票否决——按 URL 整段放行会把真正的权限/接口故障一起静音。
  const isDeliberateRejection = (url, status) => status === 400 && /\/quality-state$/.test(new URL(url).pathname)
  page.on('pageerror', (e) => errors.push(e.message))
  // 故意触发的那次 400，浏览器还会额外记一条 console error（它本身不带状态码，
  // 只能按 URL 认）。不放行这一条，第 4 步的证据就永远和"整页无错误"这个断言互斥。
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const where = m.location()?.url || ''
    if (where && isDeliberateRejection(where, 400)) return
    errors.push(`console: ${m.text().slice(0, 300)} @ ${where.slice(0, 120)}`)
  })
  page.on('requestfailed', (r) => errors.push(`reqfail: ${r.url().slice(0, 120)}`))
  page.on('response', (r) => {
    if (r.status() >= 400 && !isDeliberateRejection(r.url(), r.status())) errors.push(`http ${r.status()}: ${r.url().slice(0, 140)}`)
  })
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
      const responseHeaders = Object.fromEntries(res.headers)
      delete responseHeaders['content-length']
      delete responseHeaders['content-encoding']
      return route.fulfill({ status: res.status, headers: responseHeaders, body })
    }
    const target = path.resolve(dist, '.' + url.pathname)
    if (fs.existsSync(target) && fs.statSync(target).isFile()) return route.fulfill({ path: target })
    if (/\.(js|css|png|jpg|svg|woff2?|map|ico)$/i.test(url.pathname)) {
      return route.fulfill({ status: 404, body: '' })
    }
    return route.fulfill({ path: path.join(dist, 'index.html'), headers: { 'Content-Security-Policy': csp } })
  })
  // 直接把已登录态写进 localStorage：绕开登录表单，但不绕开任何权限判定。
  await page.addInitScript((a) => {
    if (a && a.token) localStorage.setItem('pocketbase_auth', JSON.stringify({ token: a.token, record: a.record, model: a.record }))
  }, auth)
  page.__errors = errors
  return page
}

const entriesSection = (page) => page.locator('section', { has: page.locator('h2', { hasText: '条目管理' }) }).first()
const rowButton = (page, index = 0) =>
  page.locator('section:has(h2:text("条目管理")) tbody tr').nth(index).getByRole('button', { name: /设置第 \d+ 条的质量状态/ })
// 必须限定在筛选条里：每行的「标注」按钮 aria-label 也含「质量状态」四个字，
// 不限定作用域时 getByLabel('质量状态') 会同时命中那 4 个按钮。
// 按选项定位而不是按可见文案：筛选条里有两个 select，而「质量状态」这四个字还出现在
// 每行「标注」按钮的 aria-label 里，按名字取会同时命中 5 个元素。
const qualityFilter = (page) => page.locator('.admin-list-filters select').filter({ has: page.locator('option[value="withheld"]') })
// 对话框里只有这一个 select，直接取首个即可（filter({has}) 里的内层 locator 若已按 dialog
// 作用域，Playwright 会当成二次限定而匹配不到）。
const targetStateSelect = (dialog) => dialog.locator('select').first()
const basisInput = (dialog) => dialog.locator('textarea')

async function openProject (page, projectId) {
  await page.goto(`http://localhost/admin/projects/${projectId}`)
  await entriesSection(page).waitFor({ timeout: 60000 })
  // 等汇总芯片出现：它是本套件的主要证据，没有它这张图不成立。
  await page.locator('.badge', { hasText: /·\s*\d+/ }).first().waitFor({ timeout: 60000 })
  await page.waitForTimeout(500)
}

;(async () => {
  const browser = await chromium.launch({
    headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {})
  })
  try {
    fs.mkdirSync(out, { recursive: true })

    // ---------- 1. 汇总与筛选：三桶计数、行内徽标 ----------
    const manager = await session(browser, fixture.manager)
    await openProject(manager, fixture.project.id)
    const summaryText = await entriesSection(manager).innerText()
    for (const label of ['待定', '已确认', '暂缓外发']) {
      assert.match(summaryText, new RegExp(label), `汇总缺 ${label} 这一桶：${summaryText.slice(0, 300)}`)
    }
    assert.match(summaryText, /共 4 条/, `汇总总数不对：${summaryText.slice(0, 300)}`)
    await shoot(manager, 'quality-state-summary')

    // ---------- 2. 筛选：选「暂缓外发」后只剩那一行 ----------
    await qualityFilter(manager).selectOption('withheld')
    await manager.waitForTimeout(1500)
    const filteredRows = await manager.locator('section:has(h2:text("条目管理")) tbody tr').count()
    assert.equal(filteredRows, 1, `筛暂缓外发应只剩 1 行，实得 ${filteredRows}`)
    await shoot(manager, 'quality-state-filter-withheld')
    await qualityFilter(manager).selectOption('')
    await manager.waitForTimeout(1000)

    // ---------- 3. 依据必填：目标为「已确认」而依据为空时保存被禁用 ----------
    // 第一行是夹具里已经标成「已确认」的那条，所以同值写入会在下一步被服务端拒绝。
    await rowButton(manager).click()
    const dialog = manager.locator('[role="dialog"]')
    await dialog.waitFor({ timeout: 20000 })
    await targetStateSelect(dialog).selectOption('validated')
    assert.equal(await dialog.getByRole('button', { name: '保存' }).isDisabled(), true,
      '依据为空时「保存」必须被禁用——这是 #172「不能只改一个裸枚举」的前端一侧')
    await shoot(manager, 'quality-state-basis-required')

    // ---------- 4. 服务端拒绝：同值写入被挡，理由原样显示 ----------
    await basisInput(dialog).fill('再确认一次')
    await dialog.getByRole('button', { name: '保存' }).click()
    await dialog.locator('[role="alert"]').waitFor({ timeout: 20000 })
    const rejection = await dialog.locator('[role="alert"]').innerText()
    assert.match(rejection, /已经是/, `服务端拒绝的理由没有显示出来：${rejection}`)
    await shoot(manager, 'quality-state-server-rejected')

    // ---------- 5. 成功路径：改成「暂缓外发」后汇总跟着变 ----------
    await targetStateSelect(dialog).selectOption('withheld')
    await basisInput(dialog).fill('权利未决，暂不外发')
    await dialog.getByRole('button', { name: '保存' }).click()
    await dialog.waitFor({ state: 'hidden', timeout: 20000 })
    await manager.waitForTimeout(1500)
    const afterText = await entriesSection(manager).innerText()
    assert.match(afterText, /暂缓外发 · 2/, `改动后汇总没有跟着变：${afterText.slice(0, 300)}`)
    await shoot(manager, 'quality-state-after-change')

    // ---------- 6. 空态：还没有条目的项目 ----------
    const empty = await session(browser, fixture.manager)
    await empty.goto(`http://localhost/admin/projects/${fixture.emptyProject.id}`)
    await empty.getByText('暂无条目，请上传 CSV 文件').waitFor({ timeout: 60000 })
    await shoot(empty, 'quality-state-empty-project')

    for (const [page, label] of [[manager, 'manager'], [empty, 'empty']]) {
      assert.deepEqual(page.__errors, [], `${label} 页面出现错误：${JSON.stringify(page.__errors.slice(0, 5))}`)
    }
    for (const [name, size] of shots) console.log(`screenshot ${name}.png ${size} bytes`)
  } finally {
    await browser.close()
  }
})().catch((error) => { console.error(error); process.exit(1) })

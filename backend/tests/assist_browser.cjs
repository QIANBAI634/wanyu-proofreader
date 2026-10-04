// #234 / #162 / #228 的界面证据：管理端机器疑点区块三态、大厅层级派发，
// 以及校对端在「门控挡住」与「人工放行」两种档位下的编辑页实况。
//
// 与 pdf_upload_browser.cjs 同一套做法：静态资源从 frontend/dist 取，**/api/* 一律转发给
// 真实的 harness 服务端**（fixture.base），所以截图里的数字来自真库真判据，不是 mock。
// 由 assist_browser_integration.mjs 通过环境变量驱动；缺 playwright 或构建产物时报错退出，
// 绝不静默产出一张"看起来对"的空图。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

const fixture = JSON.parse(fs.readFileSync(process.env.ASSIST_BROWSER_FIXTURE))
const dist = path.resolve(__dirname, '../../frontend/dist')
const csp = fs.readFileSync(path.resolve(__dirname, '../../frontend/nginx.conf'), 'utf8')
  .match(/add_header Content-Security-Policy "([^"]+)"/)[1]
const out = process.env.ASSIST_BROWSER_OUTPUT || path.resolve(__dirname, '../../output/playwright/assist-admin')
assert.ok(fs.existsSync(path.join(dist, 'index.html')),
  '需要先构建前端（cd frontend && npm run build），否则截图会是空白页')

const shots = []
async function shoot (page, name) {
  const file = path.join(out, `${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  assert.ok(fs.existsSync(file) && fs.statSync(file).size > 4096, `截图为空：${file}`)
  shots.push([name, fs.statSync(file).size])
}

async function session (browser, auth, tolerated = []) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const errors = []
  // 有些 4xx 是**界面本该如实处理的空态**，不是页面故障：CSV 导入的项目没有 PDF，
  // 编辑页的预览面板就走「没有可预览的 PDF」分支。把它当错误会让整条证据链
  // 只能靠删断言通过；把它单独豁免，其余任何 4xx 依然一票否决。
  const isTolerated = (url) => tolerated.some((pattern) => pattern.test(url))
  page.on('pageerror', (e) => errors.push(e.message))
  // 资源类 4xx 浏览器还会额外记一条 console error，而它本身不带 URL：
  // 不取 location 的话，豁免就退化成"按文案放行"，那等于任何 404 都能被一句话抹掉。
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const where = m.location()?.url || ''
    if (isTolerated(where)) return
    errors.push(`console: ${m.text().slice(0, 400)} @ ${where.slice(0, 140)}`)
  })
  page.on('requestfailed', (r) => errors.push(`reqfail: ${r.url().slice(0, 120)} ${r.failure()?.errorText}`))
  page.on('response', (r) => {
    // 只豁免「没有可预览的 PDF」那一种：该路由 404 是空态（pdf_access.go:76），
    // 403 是登录/成员/租约信号（:48,58,62，`pdf_reuse_integration.mjs` 就是把 403 当结论断言的），
    // 按 URL 整段放行会把后者一起静音。console 那条没有状态码，仍按 URL 豁免。
    if (r.status() >= 400 && !(r.status() === 404 && isTolerated(r.url()))) {
      errors.push(`http ${r.status()}: ${r.url().slice(0, 140)}`)
    }
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
    // 带扩展名的资源请求绝不退回 index.html：HTML 当 JS/CSS 解析会直接把页面炸进错误边界
    if (/\.(js|css|png|jpg|svg|woff2?|map|ico)$/i.test(url.pathname)) {
      return route.fulfill({ status: 404, body: '' })
    }
    return route.fulfill({ path: path.join(dist, 'index.html'), headers: { 'Content-Security-Policy': csp } })
  })
  // 直接把已登录态写进 localStorage：绕开登录表单，但不绕开任何权限判定——
  // 后面每个请求仍带该身份的 token，403 就是真 403。
  await page.addInitScript((a) => {
    if (a && a.token) localStorage.setItem('pocketbase_auth', JSON.stringify({ token: a.token, record: a.record, model: a.record }))
  }, auth)
  page.__errors = errors
  return page
}

async function assistBlockText (page, projectId) {
  await page.goto(`http://localhost/admin/projects/${projectId}`)
  const block = page.locator('section', { has: page.locator('h2', { hasText: '机器疑点' }) }).first()
  await block.waitFor({ timeout: 60000 })
  await block.scrollIntoViewIfNeeded()
  return block.innerText()
}

async function dismissOnboarding (page) {
  // 首次进编辑页会弹新手引导，模态层会挡住一切点击。这里是**替校对员点掉它**，
  // 不是把 DOM 删掉：证据要的是引导关掉之后真实的工作台界面。
  const skip = page.locator('.onboarding-skip')
  if (!await skip.count()) return
  await skip.first().click({ timeout: 20000 })
  await skip.first().waitFor({ state: 'hidden', timeout: 20000 })
}

;(async () => {
  const browser = await chromium.launch({
    headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {})
  })
  try {
    fs.mkdirSync(out, { recursive: true })

    // ---------- 1. 正常态：有疑点、有 gate 列与判据数字 ----------
    const manager = await session(browser, fixture.manager)
    await manager.goto(`http://localhost/admin/projects/${fixture.projectWithFindings.id}`)
    await manager.waitForTimeout(2500)
    if (process.env.ASSIST_BROWSER_DEBUG) {
      console.log('URL:', manager.url())
      console.log('按钮:', JSON.stringify((await manager.locator('button').allInnerTexts()).filter(Boolean).slice(0, 40)))
      console.log('正文片段:', (await manager.innerText('body')).slice(0, 600).replace(/\n+/g, ' | '))
      console.log('页面错误:', JSON.stringify(manager.__errors.slice(0, 12), null, 1))
    }
    await manager.getByRole('button', { name: '按项目重算疑点' }).click({ timeout: 60000 })
    await manager.getByText('正在重算…').waitFor({ timeout: 120000 }).catch(() => {})
    await manager.waitForFunction(() => !document.querySelector('button[disabled]')
      || !/[一-龥]*正在重算/.test(document.body.innerText), null, { timeout: 120000 })
    await manager.reload()
    const block = manager.locator('section', { has: manager.locator('h2', { hasText: '机器疑点' }) }).first()
    await block.waitFor({ timeout: 60000 })
    const blockText = await block.innerText()
    // 断言的是"截图里有东西可看"，不是"我预期它长这样"：
    // 必须出现 gate 值与至少一个 kind，否则这张图不能当验收证据。
    assert.match(blockText, /off|warn|strong/, `管理端区块没显示档位：${blockText.slice(0, 400)}`)
    assert.match(blockText, /当前批次 \d+ 条/, `管理端区块没有计数：${blockText.slice(0, 400)}`)
    await manager.getByRole('button', { name: '重算跨行身份' }).click({ timeout: 60000 })
    await manager.waitForTimeout(2500)
    await block.scrollIntoViewIfNeeded()
    await shoot(manager, 'findings-normal')
    const afterIdentity = await (await manager.locator('section', { has: manager.locator('h2', { hasText: '机器疑点' }) }).first()).innerText()
    assert.match(afterIdentity, /当前批次 \d+ 条/)

    // ---------- 2. 空态之一：从没跑过重算（不得暗示"这批干净"） ----------
    const never = await session(browser, fixture.manager)
    await never.goto(`http://localhost/admin/projects/${fixture.projectNeverRun.id}`)
    await never.locator('section', { has: never.locator('h2', { hasText: '机器疑点' }) }).first().scrollIntoViewIfNeeded()
    const neverText = await never.locator('section', { has: never.locator('h2', { hasText: '机器疑点' }) }).first().innerText()
    assert.match(neverText, /还没跑过项目级重算|不表示资料干净/, `空态文案没区分成因：${neverText.slice(0, 400)}`)
    assert.equal(neverText.includes('当前批次没有疑点'), false, '未跑过的项目被说成干净')
    await shoot(never, 'findings-empty-never-run')

    // ---------- 3. 空态之二：跑过了且真的没有疑点 ----------
    const clean = await session(browser, fixture.manager)
    await clean.goto(`http://localhost/admin/projects/${fixture.projectClean.id}`)
    // "跑过了且没有疑点"是**会话内**状态：不点一次重算，界面就只能说"还没跑过"。
    // 这正是 #234 第 6 行要的区分，所以这张图必须先真的点一次。
    await clean.getByRole('button', { name: '按项目重算疑点' }).click({ timeout: 60000 })
    // 不能 reload：runs 是会话内的状态，刷新后就回到"还没跑过"，那正是设计上要的区分。
    await clean.waitForFunction(() => /跑过了，当前批次没有疑点|还没跑过项目级重算/.test(document.body.innerText),
      null, { timeout: 60000 })
    await clean.locator('section', { has: clean.locator('h2', { hasText: '机器疑点' }) }).first().scrollIntoViewIfNeeded()
    const cleanText = await clean.locator('section', { has: clean.locator('h2', { hasText: '机器疑点' }) }).first().innerText()
    assert.match(cleanText, /跑过了，当前批次没有疑点/, `全量跑过后的空态文案不对：${cleanText.slice(0, 400)}`)
    await shoot(clean, 'findings-empty-clean')

    // ---------- 4. 无权限：校对员看不到按钮，接口真 403 ----------
    const reader = await session(browser, fixture.reader)
    const probe = await fetch(`${fixture.base}/api/fangji/projects/${fixture.projectWithFindings.id}/findings/recompute`, {
      method: 'POST', headers: { Authorization: fixture.reader.token, 'Content-Type': 'application/json' }
    })
    assert.equal(probe.status, 403, `校对员竟然能触发项目级重算：${probe.status}`)
    await reader.goto(`http://localhost/admin/projects/${fixture.projectWithFindings.id}`)
    await reader.waitForTimeout(1200)
    await shoot(reader, 'findings-forbidden')
    const readerBody = await reader.innerText('body')
    // 只断言「不存在」是不够的：`ProjectDetailView.vue:659-673` 有三个都会让区块消失的分支
    // （成员但无管理权 / 登录态失效 / 非成员），而登录态是靠 localStorage 注入的——
    // 注入哪天失效，这张会截到登录页而两条负向断言照样全过。钉住预期分支的那句文案。
    assert.equal(/按项目重算疑点/.test(readerBody), false, '重算按钮对非 manager 可见')
    assert.equal(/机器疑点/.test(readerBody), false, '疑点区块对非 manager 可见')
    assert.match(readerBody, /无权限管理该项目/, `无权限态不是预期分支：${readerBody.slice(0, 300)}`)

    // ---------- 5. 大厅：层级计数与按层级领取 ----------
    const hall = await session(browser, fixture.hallReader, [/\/pdf\/descriptor/])
    await hall.goto('http://localhost/workspace')
    await hall.waitForTimeout(1500)
    await hall.goto(`http://localhost/tasks`)
    // 层级计数只在 queue-tiers 那块出现（TaskHallView 的 tierRows），所以等它出现而不是等固定时长
    const strip = hall.locator('.queue-tiers').first()
    await strip.waitFor({ timeout: 60000 })
    // 断言收在层级条本身，且要求**两档以上**：读整页 body 的 /A|B|C/ 单档也必过，
    // 而 #162 要的是分层并存（评审抓到旧图只有一枚 B 芯片）。
    assert.ok(await hall.locator('.queue-tier').count() >= 2, '大厅层级条不足两档，证明不了分层')
    const hallText = await strip.innerText()
    assert.match(hallText, /A 类 · 照抄型 · \d+/, `层级条里没有 A 档：${hallText}`)
    assert.match(hallText, /B 类 · 需判断 · \d+/, `层级条里没有 B 档：${hallText}`)
    await shoot(hall, 'hall-tiers')
    // ---------- 层级条上的两种"没有档"（#247） ----------
    // unknown（算过但信号不足）与 unlabeled（从没算过）必须各说各的；账对得上时不许
    // 出现差额告警，中性计数也不许是可点的领取入口（unknown 领不了）。
    const stripText = await hall.locator('.queue-tiers').first().innerText()
    assert.match(stripText, /A 类 · 照抄型 · 2/, `A 档计数不对：${stripText}`)
    assert.match(stripText, /信号不足 1/, `unknown 没按新文案呈现：${stripText}`)
    assert.match(stripText, /未评估 1/, `unlabeled 没按新文案呈现：${stripText}`)
    assert.equal(await hall.locator('.queue-tier--warn').count(), 0, `账对得上却出现差额告警：${stripText}`)
    assert.equal(await hall.locator('button.queue-tier--muted').count(), 0, '中性计数被渲染成了可点按钮')
    // 不再单独截一张：这一屏与上面那张逐像素相同（中间没有任何交互），
    // 多一个文件只会让人以为它是另一种状态。四种计数都在 `hall-tiers.png` 里。
    // 层级条不是装饰：点某个层级按钮会真去服务端按该层领一条并跳进编辑页（#162）。
    // 前一张只证明"数出来了"，这张证明"按了有用"。
    const tierButton = hall.locator('.queue-tiers .queue-tier:not([disabled])').first()
    const tierLabel = (await tierButton.innerText()).trim()
    await tierButton.click({ timeout: 30000 })
    await hall.waitForURL(/\/tasks\/[a-z0-9]+\/edit$/, { timeout: 60000 })
    await hall.locator('.proofread-fields').first().waitFor({ timeout: 60000 })
    await dismissOnboarding(hall)
    assert.match(tierLabel, /·\s*\d+/, `层级按钮没带数量：${tierLabel}`)
    await shoot(hall, 'hall-claim-by-tier')

    // ---------- 6. 管理端两种 off 措辞（#254） ----------
    //
    // 数据层已经钉过"这两个项目的 off 疑点各只落在一类里"，所以这里可以要求
    // 界面上**只出现一句**：两类共用一句话正是 #254 报的那个误导。
    const noChannel = await session(browser, fixture.manager)
    const noChannelText = await assistBlockText(noChannel, fixture.projectNoChannel.id)
    assert.match(noChannelText, /没有弱标注打分通道/, `无通道那一句没出现：${noChannelText.slice(0, 400)}`)
    assert.equal(/证据未达档/.test(noChannelText), false, `无通道被说成等证据：${noChannelText.slice(0, 400)}`)
    await shoot(noChannel, 'findings-no-channel')

    const waiting = await session(browser, fixture.manager)
    const waitingText = await assistBlockText(waiting, fixture.projectWaiting.id)
    assert.match(waitingText, /证据未达档/, `等证据那一句没出现：${waitingText.slice(0, 400)}`)
    assert.equal(/没有弱标注打分通道/.test(waitingText), false, `等证据被说成没有通道：${waitingText.slice(0, 400)}`)
    await shoot(waiting, 'findings-waiting-evidence')

    // ---------- 7. 校对端：门控挡住 vs 放行后疑点进编辑页 ----------
    //
    // 这两张图是整条链路唯一"校对员真的看见了东西"的证据，所以中间那次放行
    // 必须走 #228 的变更集接口（平台管理员 token），不能在这里直接改库：
    // 直接改库的话，截图证明的就只是"前端会渲染"，而不是"门控会放行"。
    const editor = await session(browser, fixture.editorReader, [/\/pdf\/descriptor/])
    await editor.goto(`http://localhost/tasks/${fixture.editorPage.id}/edit`)
    await editor.locator('.field-hint-gated').first().waitFor({ timeout: 60000 })
    await dismissOnboarding(editor)
    assert.equal(await editor.locator('.field-hint-chip').count(), 0, '规则未放行，编辑页却已经渲染了疑点')
    const gatedText = await editor.locator('.field-hint-gated').first().innerText()
    assert.match(gatedText, /暂未开放显示/, `挡住的数量没说清楚：${gatedText}`)
    await shoot(editor, 'proofreader-gated')

    const release = await fetch(`${fixture.base}/api/fangji/gates/changeset`, {
      method: 'POST',
      headers: { Authorization: fixture.admin.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ changeset: `cs-browser-${Date.now()}`, entries: fixture.editorIdentities })
    })
    const releaseStatus = release.status
    const releaseRaw = await release.text()
    assert.equal(releaseStatus, 200, `变更集被拒：${releaseStatus} ${releaseRaw}`)
    const applied = JSON.parse(releaseRaw)
    assert.equal(applied.refused, 0, `有条目没过判据：${JSON.stringify(applied.entries.filter((e) => e.action === 'refused'))}`)
    assert.ok(applied.applied >= 1, JSON.stringify(applied))

    await editor.reload()
    await dismissOnboarding(editor)
    const chips = editor.locator('.field-hint-chip')
    await chips.first().waitFor({ timeout: 60000 })
    assert.ok(await chips.count() >= 1, '放行后编辑页没有疑点芯片')
    // 高亮档专属：strong 芯片才会带 --strong 类，这是「档位→界面」那条线唯一的外在信号。
    const strongChip = editor.locator('.field-hint-chip--strong')
    assert.ok(await strongChip.count() >= 1, 'strong 档放行后没有出现高亮级疑点')
    assert.equal(await editor.locator('.field-hint-gated').count(), 0, '放行后仍提示"有疑点被挡住"')
    await strongChip.first().scrollIntoViewIfNeeded()
    await strongChip.first().click()
    // 点芯片 → locateSpan → 原文面板把命中码位标成 .source-value__hit。
    // 断言标出来的**文字**而不是"有个元素"：区间错位时元素照样在，字却是别的字。
    const hits = editor.locator('.source-value__hit')
    await hits.first().waitFor({ timeout: 20000 })
    const hitText = (await hits.first().innerText()).trim()
    assert.ok(/[一-龥]/.test(hitText), `命中标记里没有正文：${JSON.stringify(hitText)}`)
    await shoot(editor, 'proofreader-hints')

    // ---------- 8. 条目阻塞结论三态（#240 验收第 7 条） ----------
    //
    // 三张图钉的是三件不同的事：无值那张必须真是"没人登记过"（不是加载失败的空壳）、
    // 有值那张必须由**界面上的表单**写进去（不是夹具预先 UPDATE 库），
    // 无权限那张必须证明这个身份在接口上也拿不到（否则只是"前端藏起来了"）。
    const adminSession = await session(browser, fixture.admin)
    await adminSession.goto(`http://localhost/admin/projects/${fixture.projectWithFindings.id}`)
    const panel = adminSession.locator('.blocked-conclusion')
    await panel.waitFor({ timeout: 60000 })
    await adminSession.getByLabel('选择条目（本页）').selectOption(fixture.blockedPage.id)
    await adminSession.getByText('这条还没有人登记过阻塞原因。').waitFor({ timeout: 60000 })
    assert.equal(await adminSession.getByRole('button', { name: '撤销结论' }).isDisabled(), true,
      '库里没有结论时撤销按钮却是可点的')
    await panel.scrollIntoViewIfNeeded()
    await shoot(adminSession, 'blocked-conclusion-unset')

    await adminSession.getByLabel('阻塞原因').selectOption('rights_gate')
    await adminSession.getByLabel('依据（必填）').fill('浏览器验收：授权邮件 2026-10-03，本条目未获授权')
    const submit = adminSession.getByRole('button', { name: '登记结论' })
    assert.equal(await submit.isDisabled(), false, '填齐了两项仍然提交不了')
    await submit.click()
    // 回读串必须带 who/when/basis 三件，缺一件这条结论就不可复核
    await adminSession.getByText(/授权未决｜登记于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}｜依据：浏览器验收[^｜]+｜登记者：\S/).waitFor({ timeout: 60000 })
    const tierLine = adminSession.getByText(/登记后层级/)
    await tierLine.waitFor({ timeout: 60000 })
    const tierText = await tierLine.innerText()
    assert.match(tierText, /层级 C/, `登记 rights_gate 之后层级没落到 C：${tierText}`)
    assert.match(tierText, /rights_gate_blocked/, `判据里没有人工桶：${tierText}`)
    assert.equal(await adminSession.getByRole('button', { name: '撤销结论' }).isDisabled(), false,
      '已经有结论却不能撤销')
    await panel.scrollIntoViewIfNeeded()
    await shoot(adminSession, 'blocked-conclusion-settled')

    // 撤销走完整个往返：界面读回来的必须是服务端此刻的"没人登记过"，
    // 而不是把上一行的文字留在原地。
    await adminSession.getByRole('button', { name: '撤销结论' }).click()
    await adminSession.getByText('这条还没有人登记过阻塞原因。').waitFor({ timeout: 60000 })

    // 项目管理员：看得到「机器疑点」，看不到「条目阻塞结论」，且接口那边真是 403。
    const blockedProbe = await fetch(`${fixture.base}/api/fangji/pages/${fixture.blockedPage.id}/blocked-reason`, {
      headers: { Authorization: fixture.manager.token }
    })
    assert.equal(blockedProbe.status, 403, `项目管理员竟然读得到阻塞结论：${blockedProbe.status}`)
    const managerBlocked = await session(browser, fixture.manager)
    await managerBlocked.goto(`http://localhost/admin/projects/${fixture.projectWithFindings.id}`)
    const assistSection = managerBlocked.locator('section', { has: managerBlocked.locator('h2', { hasText: '机器疑点' }) }).first()
    await assistSection.waitFor({ timeout: 60000 })
    const sectionText = await assistSection.innerText()
    // 钉住"人确实进到了正确的区块"，否则一张登录过期页也能让下面的负断言全过。
    assert.match(sectionText, /机器疑点/)
    assert.equal(/条目阻塞结论/.test(sectionText), false, '阻塞结论区块对非平台管理员可见')
    await assistSection.scrollIntoViewIfNeeded()
    await shoot(managerBlocked, 'blocked-conclusion-no-permission')

    const all = [manager, never, clean, reader, hall, noChannel, waiting, editor, adminSession, managerBlocked]
    for (const p of all) assert.deepEqual(p.__errors, [], `页面脚本报错：${p.__errors.join(' | ')}`)
    console.log('ASSIST BROWSER OK', JSON.stringify(shots))
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error('assist_browser 失败：', error.message)
  process.exit(1)
})

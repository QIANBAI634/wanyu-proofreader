const assert = require('node:assert/strict')
const { mkdir } = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')

const output = process.env.MODAL_SCREENSHOTS || path.resolve(__dirname, '../../../output/playwright/modal')
const baseUrl = process.env.REVIEW_BASE_URL || 'http://localhost:5173'

async function main() {
  await mkdir(output, { recursive: true })
  const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome' })
  try {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('dialog', dialog => dialog.accept())
    await page.addInitScript(() => {
      localStorage.clear()
      localStorage.setItem('fangji:onboarding:v1:fixture-user', JSON.stringify({ completed: true }))
    })
    const row = { 字词: '测试', 读音: 'tɛ', 释义: '虚构测试材料' }
    const record = { id: 'page1', project: 'project1', page_number: 1, ocr_row_json: JSON.stringify(row) }
    let submissions = 0
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url()).pathname
      if (url.endsWith('/arbitrate') || url.endsWith('/submit')) submissions += 1
      let data = { items: [], totalItems: 0, totalPages: 1, page: 1, perPage: 100 }
      if (url.endsWith('/task')) data = record
      if (url.endsWith('/claim')) data = { ...record, leaseToken: 'fixture-lease', leaseExpiresAt: '2099-01-01T00:00:00Z' }
      if (url.endsWith('/mine')) data = [record]
      if (url.endsWith('/keyboards')) data = { items: [] }
      if (url.endsWith('/arbitration')) data = { page: record, attempts: [
        { id: 'a', pass_no: 1, row_json: JSON.stringify(row) },
        { id: 'b', pass_no: 2, row_json: JSON.stringify({ ...row, 读音: 'ta' }) }
      ] }
      await route.fulfill({ json: data })
    })

    for (const admin of [false, true]) for (const mobile of [false, true]) {
      const label = `${admin ? 'arbitration' : 'proofread'}-${mobile ? 'mobile' : 'desktop'}`
      await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 })
      await page.goto(`${baseUrl}/tests/fixtures/review.html${admin ? '?admin' : ''}`)
      await page.locator(admin ? '.arbitration-field' : '.proofread-field').first().waitFor()
      if (admin) {
        assert.equal(await page.getByRole('button', { name: '检查并完成仲裁', exact: true }).first().isDisabled(), true)
        await page.getByRole('button', { name: '采用原文', exact: true }).first().click()
      }
      if (mobile) {
        const navigation = page.getByRole('navigation', { name: '字段导航' })
        await navigation.getByRole('combobox').selectOption(admin ? '0' : '2')
        await navigation.getByRole('button', { name: '整条总览', exact: true }).click()
      }
      const triggers = mobile
        ? page.getByRole('navigation', { name: '字段导航' }).getByRole('button', { name: '检查并提交', exact: true })
        : page.getByRole('button', { name: admin ? '检查并完成仲裁' : '检查并提交', exact: true })
      // Exercise both desktop arbitration entry points and the mobile entry point.
      for (let index = 0; index < await triggers.count(); index += 1) {
        const trigger = triggers.nth(index)
        await trigger.focus()
        const previousOverflow = await page.evaluate(() => document.body.style.overflow)
        await trigger.press('Enter')
        const dialog = page.getByRole('dialog')
        await dialog.waitFor()
        assert.equal(await dialog.evaluate(el => el.parentElement.parentElement === document.body), true)
        assert.equal(await dialog.getAttribute('tabindex'), '-1')
        assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden')
        const confirm = dialog.getByRole('button', { name: admin ? '确认完成仲裁' : '确认并提交', exact: true })
        if (admin) await page.waitForFunction(() => document.activeElement?.hasAttribute('autofocus'))
        assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true)
        if (admin) assert.equal(await confirm.evaluate(el => el === document.activeElement), true)
        await page.screenshot({ path: path.join(output, `${label}-${index}-opened.png`) })
        const values = await page.locator('textarea').evaluateAll(elements => elements.map(el => el.value))
        for (const key of ['Tab', 'Shift+Tab']) {
          for (let turn = 0; turn < 8; turn += 1) {
            const before = await dialog.evaluate(() => document.activeElement.textContent)
            await page.keyboard.press(key)
            assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true, `${label}: ${key} escaped`)
            assert.notEqual(await dialog.evaluate(() => document.activeElement.textContent), before, `${label}: focus did not cycle`)
            if (turn === 0) await page.screenshot({ path: path.join(output, `${label}-${index}-${key === 'Tab' ? 'tab' : 'shift-tab'}-first.png`) })
          }
          await page.screenshot({ path: path.join(output, `${label}-${index}-${key === 'Tab' ? 'tab' : 'shift-tab'}.png`) })
        }
        const scrollPositions = () => page.evaluate(() => [window.scrollY, ...[...document.querySelectorAll('*')].filter(el => el.scrollHeight > el.clientHeight).map(el => el.scrollTop)])
        const beforeScroll = await scrollPositions()
        await page.mouse.move(5, 5)
        await page.mouse.wheel(0, 600)
        await page.keyboard.press('PageDown')
        await page.waitForTimeout(200)
        assert.deepEqual(await scrollPositions(), beforeScroll, `${label}: background scrolled`)
        assert.deepEqual(await page.locator('textarea').evaluateAll(elements => elements.map(el => el.value)), values)
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'hidden' })
        assert.equal(await trigger.evaluate(el => el === document.activeElement), true)
        assert.equal(await page.evaluate(() => document.body.style.overflow), previousOverflow)
        await page.screenshot({ path: path.join(output, `${label}-${index}-restored.png`) })
        // Cancel and backdrop dismissal must also restore focus and scrolling.
        for (const backdrop of [false, true]) {
          await trigger.press('Enter')
          await dialog.waitFor()
          if (backdrop) await page.locator('.modal-backdrop').click({ position: { x: 5, y: 5 } })
          else await dialog.getByRole('button', { name: '继续检查', exact: true }).click()
          await dialog.waitFor({ state: 'hidden' })
          assert.equal(await trigger.evaluate(el => el === document.activeElement), true)
          assert.equal(await page.evaluate(() => document.body.style.overflow), previousOverflow)
        }
      }
    }
    assert.equal(submissions, 0, 'Review/dismissal submitted a record')
    assert.deepEqual(errors, [])
    console.log(`PASS: both review modals, desktop/mobile focus loops, scroll lock and focus restoration. Screenshots: ${output}`)
  } finally {
    await browser.close()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })

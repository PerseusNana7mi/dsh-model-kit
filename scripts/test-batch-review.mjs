import { build } from 'esbuild'
import { createServer } from 'node:http'
import { mkdir } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { chromium, expect } from '@playwright/test'

const result = await build({
  entryPoints: ['test/batch-review-fixture.tsx'],
  bundle: true,
  write: false,
  format: 'iife',
  jsx: 'automatic',
  loader: { '.css': 'text' },
})
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/app.js' ? 'text/javascript' : 'text/html; charset=utf-8')
  res.end(
    req.url === '/app.js'
      ? result.outputFiles[0].text
      : '<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:system-ui;margin:12px}#root{max-width:760px;margin:auto}</style><div id="root"></div><script src="/app.js"></script></html>',
  )
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 960, height: 1000 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByText('更多模型操作', { exact: true }).click()
  const panel = page.locator('.dmm-batch-review')
  await panel.locator('summary').first().click()
  assert.equal(await page.evaluate(() => window.batchHarness.calls.filter((r) => r.action === 'batchReview').length), 0)
  await expect(panel.getByRole('checkbox')).toHaveCount(200)
  await expect(panel).toContainText('仅展示前 200 个')
  await expect(panel.getByRole('button', { name: '选择筛选结果', exact: true })).toBeDisabled()
  await panel.getByLabel('核对供应商范围').selectOption('gateway')
  await panel.getByRole('button', { name: '选择筛选结果', exact: true }).click()
  await expect(panel).toContainText('已选 2 / 100')
  const preview = panel.getByRole('button', { name: '获取最新目录并预览', exact: true })
  await preview.click()
  const results = panel.getByLabel('批量核对结果', { exact: true })
  await expect(results).toContainText('已核对 2 个模型')
  const first = panel.locator('.dmm-batch-row').first()
  const scaled = panel.locator('.dmm-batch-row').nth(1)
  await first.locator('summary').click()
  await scaled.locator('summary').click()
  await expect(first.getByRole('row').filter({ hasText: '显示名' })).toContainText('保留当前值')
  const firstInput = first
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader').getByText('输入', { exact: true }) })
  assert.deepEqual(await firstInput.locator('td').allTextContents(), ['$0', '$3', '$0'])
  const scaledInput = scaled
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: '输入', exact: true }) })
  assert.deepEqual(await scaledInput.locator('td').allTextContents(), ['$2', '$3', '$2'])
  await panel.getByLabel('变化预览模式').selectOption('update')
  assert.deepEqual(await firstInput.locator('td').allTextContents(), ['$0', '$3', '$3'])
  // Multiplier reference updates always require an explicit whole-snapshot selection.
  assert.deepEqual(await scaledInput.locator('td').allTextContents(), ['$2', '$3', '$2'])
  await scaled.getByLabel('更新 gateway / scaled 的整份倍率参考快照', { exact: true }).check()
  assert.deepEqual(await scaledInput.locator('td').allTextContents(), ['$2', '$3', '$6'])
  await expect(first).toContainText('默认输出上限')
  for (const width of [390, 960]) {
    await page.setViewportSize({ width, height: 1000 })
    assert.equal(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  }
  await mkdir('work', { recursive: true })
  await panel.screenshot({ path: 'work/batch-review-ui.png' })
  await page.evaluate(() => window.batchHarness.notify())
  await expect(results.getByRole('alert')).toContainText('可能过期')
  // A request for the previous currency, including its failure, cannot replace a newer result.
  await page.evaluate(() => {
    window.batchHarness.hold = true
    window.batchHarness.fail = true
  })
  await preview.click()
  await page.waitForFunction(() => window.batchHarness.pending.length === 1)
  await panel.getByLabel('批量核对币种').selectOption('CNY')
  await expect(panel.getByLabel('批量价格数据源')).toHaveValue('basellm')
  await page.evaluate(() => {
    window.batchHarness.hold = false
    window.batchHarness.fail = false
  })
  await preview.click()
  await expect(results).toContainText('已核对 2 个模型')
  await page.evaluate(() => window.batchHarness.pending.shift()())
  await expect(results).toContainText('已核对 2 个模型')
  await expect(panel.getByRole('alert')).toHaveCount(0)
  // A host refresh invalidates a pending preview as well as an already displayed one.
  await page.evaluate(() => {
    window.batchHarness.hold = true
  })
  await preview.click()
  await page.waitForFunction(() => window.batchHarness.pending.length === 1)
  await page.evaluate(() => window.batchHarness.notify())
  await expect(preview).toBeEnabled()
  await page.evaluate(() => window.batchHarness.pending.shift()())
  await expect(results).toHaveCount(0)
  // The batch selection never overwrites an unsaved single-model draft.
  const choose = async (name, value) => {
    await page.getByRole('button', { name, exact: true }).click()
    const list = page.getByRole('listbox', { name, exact: true })
    await list.selectOption(value)
    await list.press('Enter')
  }
  await choose('已添加供应商', 'gateway')
  await choose('已配置模型', JSON.stringify(['gateway', 'm']))
  await page.getByLabel('显示名', { exact: true }).fill('未保存草稿')
  await page.evaluate(() => {
    window.batchHarness.hold = false
  })
  await preview.click()
  await expect(results).toContainText('已核对 2 个模型')
  await expect(page.getByLabel('显示名', { exact: true })).toHaveValue('未保存草稿')
  assert.equal(
    await page.evaluate(() =>
      window.batchHarness.calls.some((r) => !['list', 'routes', 'read', 'batchReview'].includes(r.action)),
    ),
    false,
  )
  // Select only intended fields, confirm output semantics and preset permission, then keep a partial receipt
  // despite notifications triggered by the in-flight write. A retry must retain the exact selection.
  await page.evaluate(() => {
    window.batchHarness.preset = true
    window.batchHarness.failPrices = true
    window.batchHarness.saveHold = true
  })
  await preview.click()
  await expect(results).toContainText('已核对 2 个模型')
  if (!(await first.locator('summary').evaluate((summary) => summary.parentElement.open)))
    await first.locator('summary').click()
  await first.getByLabel('保存 gateway / m 的显示名', { exact: true }).uncheck()
  const save = panel.getByRole('button', { name: '确认保存本批选中变化', exact: true })
  await expect(save).toBeDisabled()
  await panel.getByLabel('已核对所选模型与字段，确认写入配置', { exact: true }).check()
  await expect(save).toBeDisabled()
  await panel.getByLabel('确认本批最大输出变化同时更新每次请求的默认输出上限', { exact: true }).check()
  await expect(save).toBeDisabled()
  await panel.getByLabel('允许本次批量覆盖受保护预设参数', { exact: true }).check()
  await save.click()
  await page.waitForFunction(() => window.batchHarness.savePending.length === 1)
  await expect(panel.getByRole('button', { name: '正在保存本批…', exact: true })).toBeDisabled()
  await expect(panel.getByLabel('批量核对币种')).toBeDisabled()
  await page.evaluate(() => window.batchHarness.savePending.shift()())
  await expect(panel.locator('.dmm-batch-save')).toContainText('参数：已保存；价格：未完成')
  await expect(page.getByLabel('显示名', { exact: true })).toHaveValue('未保存草稿')
  await expect(first.getByLabel('保存 gateway / m 的显示名', { exact: true })).toBeDisabled()
  const original = await page.evaluate(() => window.batchHarness.calls.filter((r) => r.action === 'batchCommit').at(-1))
  assert.equal(original.selections.find((row) => row.id === 'm').fields.includes('name'), false)
  await page.evaluate(() => {
    window.batchHarness.failPrices = false
    window.batchHarness.saveHold = false
  })
  await panel.getByRole('button', { name: '重试未完成的批量保存', exact: true }).click()
  await expect(panel.locator('.dmm-batch-save')).toContainText('参数：已保存；价格：已保存')
  assert.deepEqual(
    await page.evaluate(() => window.batchHarness.calls.filter((r) => r.action === 'batchCommit').at(-1)),
    original,
  )
  assert.equal(await page.evaluate(() => window.batchHarness.modelWrites), 1)
  assert.equal(await page.evaluate(() => window.batchHarness.priceWrites), 1)
  await expect(page.getByLabel('显示名', { exact: true })).toHaveValue('未保存草稿')
  assert.deepEqual(errors, [])
  console.log(
    'Batch review and save passed: field selection, cap/preset confirmation, partial-save retry, own notifications, zero/multiplier prices, stale responses, draft isolation and narrow layout.',
  )
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}

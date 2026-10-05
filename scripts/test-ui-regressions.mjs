import { build } from 'esbuild'
import { createServer } from 'node:http'
import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'

const result = await build({ entryPoints: ['test/ui-regression-fixture.tsx'], bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'text' } })
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/app.js' ? 'text/javascript' : 'text/html; charset=utf-8')
  res.end(req.url === '/app.js' ? result.outputFiles[0].text : '<div id="root"></div><script src="/app.js"></script>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const chooseProvider = async provider => {
    await page.getByRole('button', { name: '已添加供应商' }).click()
    const list = page.getByRole('listbox', { name: '已添加供应商' })
    await list.selectOption(provider); await list.press('Enter')
  }
  const open = async (scenario = '') => {
    await page.goto(`http://127.0.0.1:${server.address().port}/?scenario=${scenario}`)
    await chooseProvider('gateway')
  }
  const select = async id => {
    await page.getByRole('button', { name: '已配置模型' }).click()
    const list = page.getByRole('listbox', { name: '已配置模型' })
    await list.selectOption(JSON.stringify(['gateway', id])); await list.press('Enter')
    await expect(page.getByLabel('模型 ID', { exact: true })).toHaveValue(id)
  }
  const fill = () => page.getByRole('button', { name: '填入模型信息', exact: true }).click()
  const save = () => page.getByRole('button', { name: '保存', exact: true }).click()
  await open('official'); await select('gpt-a'); await fill()
  await expect(page.getByLabel('推理 / 思考', { exact: true })).toBeChecked()
  await page.getByRole('button', { name: '撤销本次填入' }).click()
  await expect(page.getByLabel('推理 / 思考', { exact: true })).not.toBeChecked()
  await fill()
  await expect(page.getByLabel('推理 / 思考', { exact: true })).toBeChecked()
  await expect(page.locator('.dmm-fill-status')).toHaveAttribute('title', /官方加权一致性匹配/)
  await expect(page.getByLabel('图片输入', { exact: true })).toBeChecked()
  await page.getByLabel('图片输入', { exact: true }).uncheck()
  await fill()
  await expect(page.getByLabel('图片输入', { exact: true })).toBeChecked()
  await save()
  assert.deepEqual(await page.evaluate(() => window.harness.calls.find(r => r.action === 'model').patch.reasoningEfforts), { low: 'low', high: 'high', max: 'max' })
  await open('unknown-efforts'); await select('gpt-a'); await fill()
  await expect(page.locator('.dmm-reasoning-note')).toHaveCount(0)
  await expect(page.locator('.dmm-fill-status')).toHaveAttribute('title', /支持推理，档位未知/)
  assert.equal(await page.getByLabel('推理 / 思考', { exact: true }).evaluate(el => el.indeterminate), true)
  assert.equal(await page.evaluate(() => window.harness.calls.some(r => r.action === 'model')), false)
  const release = async () => {
    await page.evaluate(() => window.harness.release())
    // Drain promise callbacks and React rendering, without arbitrary timing sleeps.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }
  // An invalidation can remove the selected model while its reload is in flight.
  // Neither a stale success nor a stale failure may alter the new model's loading state.
  for (const fail of [false, true]) {
    await open(); await select('gpt-a')
    await page.evaluate(() => { window.harness.holdRead = true })
    await page.getByRole('button', { name: '重新读取（丢弃草稿）' }).click()
    await expect(page.getByRole('button', { name: '已配置模型', exact: true })).toBeDisabled()
    await page.evaluate(() => {
      window.oldRead = { release: window.harness.release, reject: window.harness.reject }
      window.harness.removeModel('gpt-a'); window.harness.holdRead = true
    })
    await page.getByRole('button', { name: '已配置模型', exact: true }).click()
    const pendingList = page.getByRole('listbox', { name: '已配置模型', exact: true })
    await pendingList.selectOption(JSON.stringify(['gateway', 'gpt-b'])); await pendingList.press('Enter')
    await page.waitForFunction(() => window.harness.release !== window.oldRead.release)
    await page.evaluate(fail => { if (fail) window.oldRead.reject(); else window.oldRead.release() }, fail)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await expect(page.getByRole('button', { name: '已配置模型', exact: true })).toBeDisabled()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await release()
    await expect(page.getByLabel('显示名', { exact: true })).toBeVisible()
    await expect(page.getByLabel('显示名', { exact: true })).toHaveValue('gpt-b')
    await page.getByLabel('显示名', { exact: true }).fill('B edited')
    await save()
    assert.equal(await page.evaluate(() => window.harness.calls.find(r => r.action === 'model').id), 'gpt-b')
  }
  await open('image-only'); await select('gpt-a')
  await page.getByLabel('显示名', { exact: true }).fill('Renamed image model'); await save()
  assert.deepEqual(await page.evaluate(() => window.harness.calls.find(r => r.action === 'model').patch), { name: 'Renamed image model' })
  for (const width of [390, 1000]) {
  await page.setViewportSize({ width, height: 750 })
  await open('save-layout'); await select('gpt-a'); await fill()
  await page.getByText('高级比较', { exact: true }).click()
  await page.evaluate(() => {
    window.layoutFrames = []; window.recordLayout = true;
    const sample = () => {
      const selectors = ['.dmm-navigation', '.dmm-model-capabilities', '.dmm-capacities', '.dmm-save-bar'];
      window.layoutFrames.push(selectors.map(selector => { const r = document.querySelector(selector).getBoundingClientRect(); return [r.y, r.height] }));
      if (window.recordLayout) requestAnimationFrame(sample);
    }; sample();
  })
  await save()
  await expect(page.locator('.dmm-save-bar')).toContainText('已保存模型参数和定价')
  await page.waitForTimeout(250)
  const frames = await page.evaluate(() => { window.recordLayout = false; return window.layoutFrames })
  assert.ok(frames.length > 3)
  const shifted = frames.filter(frame => frame.some((rect, i) => rect.some((v, j) => Math.abs(v - frames[0][i][j]) > 1)))
  assert.equal(shifted.length, 0, `Save layout shifted: ${JSON.stringify({ first: frames[0], shifted: shifted.slice(0, 3) })}`)
  await expect(page.locator('.dmm-source-advanced')).toHaveAttribute('open', '')
  }
  await page.setViewportSize({ width: 1280, height: 720 })
  for (const hold of ['holdCandidates', 'holdQuote']) {
    await open(); await select('gpt-a')
    await page.evaluate(hold => { window.harness[hold] = true }, hold)
    await fill(); await page.waitForFunction(() => !!window.harness.release)
    await select('gpt-b'); await release()
    await expect(page.getByLabel('显示名', { exact: true })).toHaveValue('gpt-b')
    await expect(page.getByLabel('上下文窗口', { exact: true })).toHaveValue('')
    await expect(page.locator('.dmm-prices')).not.toContainText('$')
    await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
    assert.equal(await page.evaluate(() => window.harness.calls.some(r => ['model', 'priceDraft', 'multiplier'].includes(r.action))), false)
  }
  await open(); await select('gpt-a')
  await page.evaluate(() => { window.harness.holdCandidates = true })
  await fill(); await page.waitForFunction(() => !!window.harness.release)
  await page.getByRole('button', { name: '重新读取（丢弃草稿）' }).click(); await release()
  await expect(page.getByLabel('上下文窗口', { exact: true })).toHaveValue('')

  await open('unpriced'); await select('gpt-a'); await fill()
  await expect(page.getByLabel('上下文窗口', { exact: true })).toHaveValue('128000')
  await expect(page.locator('.dmm-fill-status')).toContainText('未找到可靠价格')
  await expect(page.getByRole('button', { name: '参数参考来源' })).not.toBeVisible()
  await expect(page.locator('.dmm-prices')).not.toContainText('$')
  await save(); await expect(page.getByRole('alert')).toHaveCount(0)

  await open('conflict'); await select('gpt-a'); await fill()
  await page.getByText('高级比较', { exact: true }).click()
  await expect(page.getByLabel('上下文窗口', { exact: true })).toHaveValue('64000')
  await expect(page.getByLabel('应用上下文窗口', { exact: true })).not.toBeChecked()
  await page.getByLabel('应用上下文窗口', { exact: true }).check()
  await page.getByRole('button', { name: '应用选中差异到草稿' }).click()
  await expect(page.getByLabel('上下文窗口', { exact: true })).toHaveValue('128000')
  await save()
  assert.equal(await page.evaluate(() => window.harness.calls.find(r => r.action === 'model').patch.contextWindow), 128000)

  await open('prices'); await select('gpt-a'); await fill()
  await page.getByRole('button', { name: '编辑价格', exact: true }).click()
  await expect(page.getByLabel('输入', { exact: true })).toHaveValue('10')
  await page.getByLabel('定价模式').selectOption('multiplier')
  await page.getByLabel('统一倍率').fill('2')
  await expect(page.locator('.dmm-prices')).toContainText('$6')
  await expect(page.locator('.dmm-prices')).toContainText('$30')
  await save()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('.dmm-prices')).toContainText('$6')
  assert.equal(await page.evaluate(() => window.harness.calls.find(r => r.action === 'multiplier').quoteTicket), 'quote-gpt-a')
  await page.getByLabel('定价模式').selectOption('manual'); await save()
  await expect(page.locator('.dmm-prices')).toContainText('$10')
  await expect(page.locator('.dmm-prices')).toContainText('$20')

  await open(); await select('gpt-a')
  await page.evaluate(() => { window.harness.holdQuote = true })
  await fill(); await page.waitForFunction(() => !!window.harness.release)
  await page.getByRole('button', { name: '编辑价格', exact: true }).click()
  await page.getByLabel('输入', { exact: true }).fill('7')
  await release(); await expect(page.getByLabel('输入', { exact: true })).toHaveValue('7')
  await expect(page.getByLabel('输出', { exact: true })).toHaveValue('15')
  await save(); await expect(page.getByRole('alert')).toHaveCount(0)
  const saved = await page.evaluate(() => window.harness.saved['gpt-a'])
  assert.equal(saved.record.rates.input.origin, 'manual')
  assert.equal(saved.record.rates.output.origin, 'catalog')
  assert.equal(saved.record.rates.output.source.provider, 'openai')
  await page.getByRole('button', { name: '重新读取（丢弃草稿）' }).click()
  await expect(page.getByText(/定价参考来源：openai/)).toBeVisible()
  await page.getByLabel('显示名', { exact: true }).fill('Renamed'); await save()
  assert.deepEqual(await page.evaluate(() => window.harness.saved['gpt-a'].record.rates), saved.record.rates)

  // Host invalidations refresh all navigation lists without destroying an in-progress edit.
  await open(); await select('gpt-a')
  await page.getByLabel('显示名', { exact: true }).fill('Unsaved draft')
  await page.evaluate(() => window.harness.addProvider())
  await page.getByRole('button', { name: '已添加供应商' }).click()
  await expect(page.getByRole('listbox', { name: '已添加供应商' }).locator('option[value="new-route"]')).toHaveCount(1)
  await page.getByRole('listbox', { name: '已添加供应商' }).press('Escape')
  await expect(page.getByLabel('显示名', { exact: true })).toHaveValue('Unsaved draft')
  await page.getByRole('button', { name: '已配置模型' }).click()
  await expect(page.getByRole('listbox', { name: '已配置模型' }).locator('option')).toHaveCount(3)
  await page.getByRole('listbox', { name: '已配置模型' }).press('Escape')
  await page.getByText('更多模型操作', { exact: true }).click()
  await page.getByText('从上游导入模型', { exact: true }).click()
  await expect(page.getByLabel('导入目标供应商').locator('option[value="new-route"]')).toHaveCount(1)
  await chooseProvider('new-route')
  await expect(page.getByLabel('模型 ID', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '已配置模型' }).click()
  await expect(page.getByRole('listbox', { name: '已配置模型' }).locator('option')).toHaveCount(201)
  await page.getByRole('searchbox', { name: '搜索已配置模型' }).fill('new-349')
  await expect(page.getByRole('listbox', { name: '已配置模型' }).locator('option')).toHaveCount(2)
  await page.getByRole('searchbox', { name: '搜索已配置模型' }).press('Enter')
  await expect(page.getByLabel('模型 ID', { exact: true })).toHaveValue('new-349')
  await page.evaluate(() => window.harness.removeProvider())
  await expect(page.getByLabel('模型 ID', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '已配置模型' })).toBeDisabled()
  await expect(page.getByLabel('导入目标供应商').locator('option[value="new-route"]')).toHaveCount(0)
  assert.deepEqual(errors, [])
  console.log('Regression UI checks passed: stale responses, one-click fill, quote pricing, provenance, live lists, provider isolation and 350-model search.')
} finally {
  await browser?.close(); server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}

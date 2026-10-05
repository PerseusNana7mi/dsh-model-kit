import { build } from 'esbuild'
import { createServer } from 'node:http'
import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'

const result = await build({ entryPoints: ['test/editor-safety-fixture.tsx'], bundle: true, write: false, format: 'iife', jsx: 'automatic' })
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
  page.on('pageerror', e => errors.push(e.message))
  const open = async scenario => {
    await page.goto(`http://127.0.0.1:${server.address().port}/?scenario=${scenario}`)
    if (scenario !== 'invalid') await page.locator('summary').first().click()
  }
  await open('routes')
  await expect(page.getByRole('alert')).toContainText('内置供应商读取失败')
  await page.evaluate(() => { window.editorHarness.failRoutes = false })
  await page.getByRole('button', { name: '重试读取内置供应商' }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.locator('select').nth(0).selectOption('openai')
  await page.getByRole('button', { name: '读取内置目录', exact: true }).click()
  await page.getByLabel('内置模型', { exact: true }).selectOption('m')
  await page.getByRole('button', { name: '读取参数（丢弃草稿）', exact: true }).click()
  const context = page.getByLabel('上下文窗口覆盖值', { exact: true })
  const output = page.getByLabel('最大输出覆盖值', { exact: true })
  const fill = () => page.getByRole('button', { name: '填入模型信息', exact: true }).click()
  const undo = () => page.getByRole('button', { name: '撤销本次填入', exact: true }).click()
  await context.fill('64000'); await fill()
  await expect(context).toHaveValue('64000'); await expect(output).toHaveValue('8000')
  await undo(); await expect(context).toHaveValue('64000'); await expect(output).toHaveValue('')
  await context.fill(''); await fill(); await expect(context).toHaveValue('128000')
  await context.fill('96000'); await undo()
  await expect(context).toHaveValue('96000'); await expect(output).toHaveValue('')
  await context.fill(''); await fill(); await undo(); await expect(context).toHaveValue('')
  // A recommendation pending during an invalid edit must not overwrite that edit.
  await page.evaluate(() => { window.editorHarness.hold = true })
  await fill(); await page.waitForFunction(() => !!window.editorHarness.release)
  await context.fill('0'); await page.evaluate(() => window.editorHarness.release())
  await expect(context).toHaveValue('0'); await expect(page.getByRole('alert')).toContainText('格式无效')
  await context.fill('64000'); await expect(page.getByRole('alert')).toHaveCount(0)
  await page.getByLabel('允许本次覆盖或恢复内置模型参数', { exact: true }).check()
  await page.getByRole('button', { name: '保存内置模型修改' }).click()
  assert.deepEqual(await page.evaluate(() => window.editorHarness.saved[0].patch), { contextWindow: 64000 })
  await open('invalid')
  await expect(page.getByRole('alert')).toContainText('推理档覆盖值格式无效')
  await page.locator('select').selectOption('disabled')
  await expect(page.getByRole('alert')).toHaveCount(0)
  assert.deepEqual(errors, [])
  console.log('Editor safety passed: manual drafts, selective undo, invalid drafts and recoverable route failure.')
} finally {
  await browser?.close(); server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}

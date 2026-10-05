import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'

const result = await build({
  stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {ModelSelect} from './src/client/ModelSelect';
    const options = Array.from({length: 20}, (_, i) => ({value: String(i), label: 'deepseek-v4-flash-0731-long-provider-name-' + i}));
    createRoot(document.getElementById('root')).render(<div className="dmm"><div className="dmm-grid dmm-model-picker"><ModelSelect label="供应商" value="" options={options} onChange={()=>{}}/><ModelSelect label="模型" value="" options={options} onChange={()=>{}}/></div></div>);`, resolveDir: process.cwd(), loader: 'tsx' },
  bundle: true, write: false, format: 'iife',
})
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  for (const zoom of [1, 1.5, 2]) {
    for (const viewport of [390, 920, 1400]) {
      const page = await browser.newPage({ viewport: { width: viewport, height: 850 } })
      await page.setContent(`<!doctype html><style>body{margin:0}#host{width:80%;height:700px;overflow:auto;margin:0 auto}#root{zoom:${zoom}}${readFileSync('src/client/style.css', 'utf8')}</style><div id="host"><div id="root"></div></div>`)
      await page.addScriptTag({ content: result.outputFiles[0].text })
      for (const label of ['供应商', '模型']) {
        await page.getByRole('button', { name: label, exact: true }).click()
        const check = async () => {
          const geometry = await page.locator('.dmm-select-popover').evaluate(popup => {
            const host = document.querySelector('#host'), bounds = host.getBoundingClientRect(), rect = popup.getBoundingClientRect()
            return { hostWidth: host.clientWidth, hostScroll: host.scrollWidth, pageWidth: document.documentElement.clientWidth, pageScroll: document.documentElement.scrollWidth, left: rect.left, right: rect.right, hostLeft: bounds.left, hostRight: bounds.right }
          })
          assert.ok(geometry.hostScroll <= geometry.hostWidth + 1, JSON.stringify(geometry))
          assert.ok(geometry.pageScroll <= geometry.pageWidth + 1, JSON.stringify(geometry))
          assert.ok(geometry.left >= geometry.hostLeft && geometry.right <= geometry.hostRight, JSON.stringify(geometry))
        }
        await check()
        await page.getByRole('searchbox').fill('long-provider')
        await expect(page.getByRole('searchbox')).toBeFocused()
        await check()
        await page.setViewportSize({ width: viewport - 30, height: 850 })
        await page.waitForTimeout(50)
        await check()
        await page.getByRole('searchbox').press('Escape')
      }
      await page.close()
    }
  }
  console.log('Dropdown bounds passed: both selectors, nested scroll container, 3 window widths, 100–200% zoom, search and resize.')
} finally { await browser.close() }

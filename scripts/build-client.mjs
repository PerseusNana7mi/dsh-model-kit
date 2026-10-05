import { build } from 'esbuild'
import { readFile, writeFile } from 'node:fs/promises'
const { name } = JSON.parse(await readFile('package.json', 'utf8'))
const result = await build({ entryPoints: ['src/client/index.ts'], write: false, bundle: true, format: 'cjs', platform: 'browser', target: 'es2022',
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/*'], loader: { '.css': 'text' }, minify: true,
})
await writeFile('lib/client.js', `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => {\nconst module = { exports: {} }; const exports = module.exports;\n${result.outputFiles[0].text}\nreturn module.exports;\n} });\n`)

// 轻量测试运行器：用 Vite 自带的 esbuild 把 TS 测试打成 CJS 后在 Node 里跑，不引入额外依赖。
const esbuild = require('esbuild')
const { writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')

async function main() {
  const result = await esbuild.build({
    entryPoints: [join(__dirname, 'quality.test.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    sourcemap: false,
    logLevel: 'silent',
    alias: { '@': join(__dirname, '..', 'src') },
  })
  const outFile = join(__dirname, '.quality.test.cjs')
  writeFileSync(outFile, result.outputFiles[0].text)
  // 测试失败时会 process.exit(1)，finally 可能被跳过，注册退出钩子保证临时产物一定清掉。
  const cleanup = () => rmSync(outFile, { force: true })
  process.on('exit', cleanup)
  try {
    require(outFile)
  } finally {
    cleanup()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

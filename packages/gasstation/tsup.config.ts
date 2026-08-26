import { defineConfig } from 'tsup'
import type { Plugin } from 'esbuild'
import { resolve } from 'node:path'

function platformSolanaAdapter(file: 'solana.browser.ts' | 'solana.native.ts'): Plugin {
  return {
    name: `platform-solana-adapter-${file}`,
    setup(build) {
      build.onResolve({ filter: /^\.\/solana\.js$/ }, (args) => ({
        path: resolve(args.resolveDir, file),
      }))
    },
  }
}

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    treeshake: true,
  },
    {
    entry: {
      'index.browser': 'src/index.ts',
    },
    format: ['esm'],
    platform: 'browser',
    bundle: true,
    noExternal: [
      'buffer',
      'safe-buffer',
      '@solana/web3.js',
      '@solana/buffer-layout',
    ],
    dts: false,
    sourcemap: true,
    treeshake: true,
  },
  {
    entry: { 'index.native': 'src/index.ts' },
    format: ['esm'],
    clean: false,
    sourcemap: true,
    treeshake: true,
    esbuildPlugins: [platformSolanaAdapter('solana.native.ts')],
    esbuildOptions(options) {
      options.conditions = ['react-native']
    },
  },
])

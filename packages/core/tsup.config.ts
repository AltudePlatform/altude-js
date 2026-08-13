import { defineConfig } from 'tsup'

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
    entry: { 'index.browser': 'src/index.browser.ts' },
    format: ['esm'],
    clean: false,
    sourcemap: true,
    treeshake: true,
  },
  {
    entry: { 'index.native': 'src/index.native.ts' },
    format: ['esm'],
    clean: false,
    sourcemap: true,
    treeshake: true,
  },
])

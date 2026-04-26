import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  // node:crypto is available natively; mark as external
  external: ['node:crypto', 'node:fs', 'node:path', 'node:os', 'node:child_process'],
})

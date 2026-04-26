import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    env: {
      // Use N=16384 (minimum allowed) during tests to avoid memory limit errors.
      // Production code uses N=65536 (OWS-mandated).
      ALTUDE_SCRYPT_N: '16384',
    },
  },
})

import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// mutabl acceptance suite (spec §15, AT-xx). Boots the real server against the
// real apps/ plugins, so it lives outside server/tests (which must not touch
// apps/). Aliases mirror server/vitest.config.ts. Run: `task acceptance:test`.
const server = resolve(__dirname, '../server')

export default defineConfig({
  resolve: {
    alias: [
      { find: 'moumantai/ui', replacement: `${server}/src/server/protocol/components/index.ts` },
      { find: 'moumantai', replacement: `${server}/src/server/framework/moumantai.ts` },
      {
        find: '@moumantai/protocol/generated/moumantai/v1',
        replacement: resolve(__dirname, '../shared/protocol/src/generated/moumantai/v1/index.ts'),
      },
      {
        find: '@moumantai/protocol/design-system',
        replacement: resolve(
          __dirname,
          '../shared/protocol/design-system/generated/design-system.ts',
        ),
      },
      {
        find: '@moumantai/protocol',
        replacement: resolve(__dirname, '../shared/protocol/src/index.ts'),
      },
    ],
  },
  test: {
    root: __dirname,
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Each test file boots its own server; pairing is exercised elsewhere.
    env: { MOUMANTAI_PAIRING_REQUIRED: 'false' },
  },
})

import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: [
    './src/server/conversations/schema.ts',
    './src/server/drafts/promotions-schema.ts',
    './src/server/change-requests/schema.ts',
    './src/server/releases/schema.ts',
    './src/server/jobs/schema.ts',
  ],
  out: './drizzle/platform',
  casing: 'snake_case',
})

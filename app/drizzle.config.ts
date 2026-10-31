import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/lib/schema.ts',
  out: './migrations',
  dbCredentials: { url: process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/notes_dev' },
});

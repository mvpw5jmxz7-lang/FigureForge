import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const pkg = (name: string) => resolve(import.meta.dirname, `packages/${name}/src/index.ts`);

export default defineConfig({
  resolve: {
    alias: {
      '@figureforge/doc-model': pkg('doc-model'),
      '@figureforge/theme': pkg('theme'),
      '@figureforge/plots': pkg('plots'),
      '@figureforge/render': pkg('render'),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'packages/**/*.test.tsx'],
    environment: 'node',
  },
});

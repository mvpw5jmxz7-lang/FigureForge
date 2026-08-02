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
    // `apps/**` was missing, so a test written there ran silently never. The
    // asset store is the one genuinely testable piece that belongs in the app.
    include: [
      'packages/**/*.test.ts',
      'packages/**/*.test.tsx',
      'apps/**/src/**/*.test.ts',
      'apps/**/src/**/*.test.tsx',
    ],
    // Deliberately not jsdom. A DOM-free environment is what makes an
    // accidental DOM import in `packages/render` fail loudly here rather than
    // silently break export fidelity later.
    environment: 'node',
  },
});

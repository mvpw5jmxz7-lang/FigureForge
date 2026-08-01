import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Build output only; the sources live in src/ and *.config.ts.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      'out/**',
      '**/*.d.ts',
      'apps/web/vite.config.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    rules: {
      // Unused args are meaningful in renderer signatures; require an
      // underscore prefix rather than deleting them.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // The document model deliberately uses non-null assertions after explicit
      // existence checks; banning them outright would add noise, not safety.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);

// Flat config: Next.js (core web vitals + TypeScript) with the full jsx-a11y recommended set.
import { createRequire } from 'node:module';
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

// eslint-plugin-jsx-a11y ships with eslint-config-next (which registers it as `jsx-a11y`);
// resolve it from there so its recommended rule list stays in step with the installed plugin.
const require = createRequire(import.meta.url);
const fromNextConfig = createRequire(require.resolve('eslint-config-next'));
const jsxA11y = fromNextConfig('eslint-plugin-jsx-a11y');

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    name: 'jarvis/a11y',
    files: ['**/*.{jsx,tsx}'],
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      // Our form controls associate labels through htmlFor/id generated with useId.
      'jsx-a11y/label-has-associated-control': ['error', { assert: 'either', depth: 3 }],
    },
  },
  {
    name: 'jarvis/rules',
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
    },
  },
  {
    name: 'jarvis/node-scripts',
    files: ['e2e/**/*.ts', 'test/**/*.ts', '*.config.{ts,mjs}'],
    rules: {
      // Playwright fixtures use a parameter named `use`, which is not a React hook.
      'react-hooks/rules-of-hooks': 'off',
    },
  },
  globalIgnores([
    '.next/**',
    '.next-*/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    'test-results/**',
    'playwright-report/**',
  ]),
]);

// Flat config for the API: ESLint recommended + typescript-eslint recommended.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Node globals for plain JavaScript files (TypeScript files are checked by tsc). */
const nodeGlobals = Object.fromEntries(
  [
    'process',
    'console',
    'Buffer',
    'URL',
    'URLSearchParams',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'structuredClone',
    'fetch',
  ].map((name) => [name, 'readonly']),
);

export default [
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: nodeGlobals },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // Text normalisation matches invisible characters (NBSP, zero-width) in regex literals.
      'no-irregular-whitespace': ['error', { skipRegExps: true }],
    },
  },
];

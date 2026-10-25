// ESLint — WARN-ONLY baseline (cleanup Phase 2, canonical plan P2 item 8).
//
// Contract: `eslint .` must always exit 0 — every rule below is 'warn', and
// no error-level preset (js.configs.recommended / svelte flat/recommended)
// is included, because those mark rules as 'error' and would fail the exit
// code. Findings surface as warnings for incremental cleanup only; the rule
// set is intentionally small and can grow (still warn-only) in later phases.
// Not part of the CI gate (ci.yml runs check/build/test only).
// Formatting is Prettier's job — no stylistic rules here.
import svelteParser from 'svelte-eslint-parser';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';

export default [
  {
    ignores: [
      'build/**', '.svelte-kit/**', 'node_modules/**', 'netlify/**', '.netlify/**',
      'scripts/stubs/**', 'scripts/env-stubs/**', 'scripts/harness/**',
      'supabase/**', 'adapter-builder/**', 'docs/**', 'static/**'
    ]
  },
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: tsParser,
        ecmaVersion: 2023,
        sourceType: 'module',
        extraFileExtensions: ['.svelte']
      },
      globals: { ...globals.browser }
    },
    plugins: { svelte },
    rules: {
      'svelte/no-at-html-tags': 'warn',
      'svelte/no-unused-svelte-ignore': 'warn'
    }
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node }
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'eqeqeq': ['warn', 'smart'],
      'prefer-const': 'warn',
      'no-var': 'warn'
    }
  }
];

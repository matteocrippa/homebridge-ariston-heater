import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Start with recommended defaults
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  // Then apply project options and rules to override
  {
  ignores: ['dist/**', 'index.js', 'homebridge-plugin-template/**'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      quotes: ['warn', 'single'],
      indent: 'off',
      'linebreak-style': ['warn', 'unix'],
      semi: ['warn', 'always'],
      'comma-dangle': ['warn', 'always-multiline'],
      'dot-notation': 'warn',
      eqeqeq: ['warn', 'smart'],
      curly: 'off',
      'brace-style': 'warn',
      'prefer-arrow-callback': 'warn',
      'max-len': ['warn', 160],
      'object-curly-spacing': ['warn', 'always'],
  'prefer-const': 'warn',
      'no-use-before-define': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      '@typescript-eslint/no-use-before-define': ['warn', { classes: false, enums: false }],
      '@typescript-eslint/no-unused-vars': ['warn', { caughtErrors: 'none' }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);

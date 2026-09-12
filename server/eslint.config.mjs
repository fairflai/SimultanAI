import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/'] },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      // A ProviderEvent kind left unhandled in Translator.handle must fail lint, not only tsc
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },
  {
    // node:test's test() returns a Promise that the runner awaits itself
    files: ['test/**'],
    rules: { '@typescript-eslint/no-floating-promises': 'off' },
  },
);

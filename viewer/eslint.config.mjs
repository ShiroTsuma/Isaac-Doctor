import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
export default [
  {ignores:['dist/**','node_modules/**','core.js','vite.config.mjs','eslint.config.mjs']},
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {files:['src/**/*.{ts,tsx}','scripts/**/*.mts'],languageOptions:{parserOptions:{projectService:true,tsconfigRootDir:import.meta.dirname}},
    plugins:{'react-hooks':hooks},rules:{...hooks.configs.recommended.rules,
      '@typescript-eslint/no-floating-promises':'error','@typescript-eslint/no-explicit-any':'error'}}
];

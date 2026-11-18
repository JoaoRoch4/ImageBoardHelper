// Lint (development only): npm run lint
const js = require('@eslint/js')
const globals = require('globals')
const tseslint = require('typescript-eslint')

const unused = ['warn', { args: 'none', caughtErrors: 'none' }]

module.exports = [
  // The userscript is generated from src/ (npm run build): its source is what gets linted.
  { ignores: ['node_modules/', 'image-board-helper.user.js'] },
  js.configs.recommended,
  // The userscript's source, src/: TypeScript, read through typescript-eslint
  // (on TypeScript 6, the package "typescript": it needs TypeScript's JavaScript
  // API, which TypeScript 7, the checking tsc, does not have). Its recommended
  // rules without the type-aware ones, which would build a second program in
  // TypeScript 6, slow on the phone: tsc already checks the types.
  ...tseslint.configs.recommended.map(c => ({ ...c, files: ['src/**/*.ts'] })),
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        GM_getValue: 'readonly',
        GM_setValue: 'readonly',
        GM_xmlhttpRequest: 'readonly',
        GM_getResourceURL: 'readonly',
        unsafeWindow: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': unused,
      // An any is a hole in the types: shown, not failing the check, until the
      // edges (storage, GM responses, the app's replies) get their checks.
      '@typescript-eslint/no-explicit-any': 'warn',
      // `on ? mount(card) : unmount(card)` as a statement is this code's style.
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
    },
  },
  {
    files: ['tools/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: globals.node },
    rules: { 'no-unused-vars': unused },
  },
  {
    // Its page.evaluate callbacks run in the browser.
    files: ['tools/smoke.js', 'tools/gif-test.js', 'tools/fav-test.js', 'tools/url-test.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
]

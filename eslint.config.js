// Lint (development only): npm run lint
const js = require('@eslint/js')
const globals = require('globals')

const unused = ['warn', { args: 'none', caughtErrors: 'none' }]

module.exports = [
  { ignores: ['node_modules/'] },
  js.configs.recommended,
  {
    // The userscript: one classic script, ES2020, browser globals plus what it is granted.
    files: ['image-board-helper.user.js'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        GM_getValue: 'readonly',
        GM_setValue: 'readonly',
        GM_xmlhttpRequest: 'readonly',
        GM_getResourceURL: 'readonly',
        unsafeWindow: 'readonly',
      },
    },
    rules: { 'no-unused-vars': unused },
  },
  {
    files: ['tools/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: globals.node },
    rules: { 'no-unused-vars': unused },
  },
  {
    // Its page.evaluate callbacks run in the browser.
    files: ['tools/smoke.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
]

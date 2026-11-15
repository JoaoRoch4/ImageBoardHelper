#!/usr/bin/env node
// Development helper, not part of the userscript: both language tables of
// I18N must have the same keys (a missing one shows up only in the panel).
'use strict'
const fs = require('fs')
const path = require('path')
const esbuild = require('esbuild')

// A module of src/ that imports nothing, run in Node: esbuild bundles it
// alone, as CommonJS.
function srcModule(name) {
  const file = ['ts', 'js'].map(ext => path.join(__dirname, '..', 'src', `${name}.${ext}`)).find(f => fs.existsSync(f))
  if (!file) throw new Error(`no src/${name}`)
  const { outputFiles } = esbuild.buildSync({ entryPoints: [file], bundle: true, write: false, format: 'cjs', logLevel: 'silent' })
  const module = { exports: {} }
  new Function('module', 'exports', outputFiles[0].text)(module, module.exports)
  return module.exports
}

const { I18N } = srcModule('core/strings')
if (!I18N) throw new Error('src/core/strings exports no I18N')
const en = Object.keys(I18N.en)
const pt = Object.keys(I18N['pt-BR'])
const onlyEn = en.filter(k => !pt.includes(k))
const onlyPt = pt.filter(k => !en.includes(k))
if (onlyEn.length || onlyPt.length) {
  console.error(`I18N mismatch — only in en: ${onlyEn.join(', ') || '-'}; only in pt-BR: ${onlyPt.join(', ') || '-'}`)
  process.exit(1)
}
console.log(`I18N: ${en.length} keys in both tables`)

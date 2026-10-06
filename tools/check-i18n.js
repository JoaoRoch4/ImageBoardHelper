#!/usr/bin/env node
// Development helper, not part of the userscript: both language tables of
// I18N must have the same keys (a missing one shows up only in the panel).
'use strict'
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'image-board-helper.user.js'), 'utf8')
const I18N = new Function(`${src.match(/const I18N = \{[\s\S]*?\n {2}\}\n/)[0]}return I18N`)()
const en = Object.keys(I18N.en)
const pt = Object.keys(I18N['pt-BR'])
const onlyEn = en.filter(k => !pt.includes(k))
const onlyPt = pt.filter(k => !en.includes(k))
if (onlyEn.length || onlyPt.length) {
  console.error(`I18N mismatch — only in en: ${onlyEn.join(', ') || '-'}; only in pt-BR: ${onlyPt.join(', ') || '-'}`)
  process.exit(1)
}
console.log(`I18N: ${en.length} keys in both tables`)

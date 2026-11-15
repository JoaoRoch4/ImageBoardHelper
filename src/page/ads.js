import { PROFILE, SITE } from '../core/site'
import { CFG } from '../core/config'
import { dbg, info } from '../core/log'

// ─── Ads ───
// Every script and frame these sites need is their own (checked on rule34,
// xbooru and safebooru); the ads come from other hosts: ExoClick's
// ad-provider.js, TrafficStars' ms.js, a popunder on a host that changes
// name, an affiliate iframe. A Content-Security-Policy <meta> in the head,
// in place before the parser reaches the body, keeps the browser from
// loading them, and CSS hides the slots they would fill. (Firefox 158 no
// longer fires beforescriptexecute, the other way to stop a script.)
const SITE_DOMAIN = SITE.split('.').slice(-2).join('.')
// challenges.cloudflare.com: Cloudflare's CAPTCHA page, which must keep working.
const OWN_HOSTS = `'self' https://${SITE_DOMAIN} https://*.${SITE_DOMAIN} https://challenges.cloudflare.com`
// One policy, no nonce (a nonce would turn 'unsafe-inline' off): inline for the
// site's own scripts and onclick handlers, eval for WebAssembly too (the
// keyframe decoder), moz-extension: for devtools extensions such as Eruda.
const AD_POLICY = `script-src ${OWN_HOSTS} ${PROFILE.scriptHosts.join(' ')} 'unsafe-inline' 'unsafe-eval' blob: moz-extension:; frame-src ${OWN_HOSTS} blob:`
// The sponsored link to an AI site sits in rule34's menu and above gelbooru's posts.
const AD_SLOTS = ['.a_list', '#nativemlist', '#nativempost', 'ins[data-zoneid]', 'li:has(> a[href*="realxxx."])', 'a[href*="realxxx."]', ...PROFILE.adSlots].join(', ')
export const ADS_CSS = `${AD_SLOTS} { display: none !important; }`
const adBlocked = new Map()   // host -> loads the policy stopped
let adPolicyOn = false

// The policy goes in once the head exists: the observer calls this first.
export function applyAdBlock() {
  if (!CFG.blockAds || adPolicyOn || !document.head) return
  adPolicyOn = true
  const meta = document.createElement('meta')
  meta.httpEquiv = 'Content-Security-Policy'
  meta.content = AD_POLICY
  document.head.prepend(meta)
  dbg('ads: policy in place, only the site\'s own scripts and frames load')
}

export function installAdBlock() {
  if (!CFG.blockAds) return
  document.addEventListener('securitypolicyviolation', e => {
    if (!e.originalPolicy.includes('moz-extension:')) return   // a policy of the site's own, not this one
    let host = e.blockedURI
    try { host = new URL(e.blockedURI).host } catch (err) { /* 'inline' and such: keep it */ }
    adBlocked.set(host, (adBlocked.get(host) || 0) + 1)
    if (document.readyState === 'complete') dbg(`ads: blocked ${e.blockedURI}`)
  })
  window.addEventListener('load', () => {
    const total = [...adBlocked.values()].reduce((a, b) => a + b, 0)
    const hosts = [...adBlocked].map(([h, n]) => (n > 1 ? `${h} ×${n}` : h)).join(', ')
    info(`ads: blocked ${total} loads${hosts ? ` (${hosts})` : ''}, ${document.querySelectorAll(AD_SLOTS).length} slots hidden`)
  }, { once: true })
  applyAdBlock()
}

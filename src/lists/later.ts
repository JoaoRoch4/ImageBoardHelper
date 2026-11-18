import { SITE } from '../core/site'
import { t } from '../core/i18n'
import { dbg, info } from '../core/log'
import { nativeTags } from '../thumbs/covers'
import { buildModal, flash, modal } from '../modal/modal'
import { GM_STORE, storeGet, storeSet } from '../storage/storage'
import { sharpenTile } from './autopager'
import { resetMedia } from '../modal/player'
import { postId } from '../modal/media'
import { openModal, openShell } from '../modal/open'
import { el } from '../panel/panel'

// ── Watch later ──
// Posts saved from the ☰ menu, newest first, opened from the 🕒 button in
// the same modal: a tap opens one, and the swipe walks the list. Each item
// keeps what the modal needs to show it off the page it came from: the post
// link, its thumbnail and its tags (they tell a video or a GIF apart).
export const LATER_MAX = 500

export type LaterItem = ReturnType<typeof laterItem>
async function laterList(): Promise<LaterItem[]> {
  const list = await storeGet('later')
  return Array.isArray(list) ? list : []
}

function laterItem(link: HTMLAnchorElement) {
  const img = link.querySelector('img')
  return {
    site: SITE,
    href: link.href,
    thumb: (img && img.getAttribute('src')) || '',   // the thumbnail, not an upgrade in srcset
    tags: nativeTags(link).trim(),
    webm: !!link.querySelector('img.webm-thumb'),
    added: Date.now(),
  }
}

// A detached stand-in for a page thumbnail, which is what the modal reads.
function laterLink(item: LaterItem) {
  const a = document.createElement('a')
  a.href = item.href
  const img = document.createElement('img')
  img.src = item.thumb
  img.title = item.tags
  if (item.webm) img.className = 'webm-thumb'
  a.appendChild(img)
  return a
}

export async function toggleLaterHere() {
  const link = modal.link
  if (!link) return
  const list = await laterList()
  const i = list.findIndex(item => item.href === link.href)
  if (i >= 0) list.splice(i, 1)
  else list.unshift(laterItem(link))
  list.length = Math.min(list.length, LATER_MAX)
  await storeSet('later', list)
  setLaterButton(i < 0)
  flash(t(i < 0 ? 'laterAdded' : 'laterRemoved'))
  info(`later: ${i < 0 ? 'saved' : 'removed'} post ${postId(link)} (${list.length} in the list)`)
}

function setLaterButton(saved: boolean) {
  modal.laterBtn.textContent = t(saved ? 'laterIn' : 'laterAdd')
  modal.laterBtn.classList.toggle('on', saved)
}

export function refreshLaterButton(link: HTMLAnchorElement, seq: number) {
  setLaterButton(false)
  laterList().then(list => {
    if (modal.seq === seq) setLaterButton(list.some(item => item.href === link.href))
  })
}

export async function showLater() {
  if (!modal) buildModal()
  resetMedia()
  modal.box.classList.add('later-mode')
  openShell()
  await renderLater()
}

async function renderLater() {
  const list = (await laterList()).filter(item => item.site === SITE)
  const title = modal.laterHead.querySelector('.lt') as Element   // buildModal made it
  title.textContent = `🕒 ${t('laterTitle')} · ${list.length}`
  modal.laterNote.textContent = t(GM_STORE ? 'laterOnDevice' : 'laterOnSite')
  if (!list.length) {
    modal.laterGrid.replaceChildren(el('div', { class: 'none', text: t('laterEmpty') }))
    return
  }
  const links = list.map(laterLink)
  if (modal.laterIO) modal.laterIO.disconnect()
  // Sharp pictures for the tiles that scroll into view (see sharpenTile).
  modal.laterIO = 'IntersectionObserver' in window
    ? new IntersectionObserver(entries => {
        for (const e of entries) {
          if (!e.isIntersecting) continue
          (modal.laterIO as IntersectionObserver).unobserve(e.target)   // set while it observes: closeModal disconnects it first
          sharpenTile(e.target as HTMLImageElement)   // it watches the tiles' images
        }
      }, { root: modal.laterView, rootMargin: '300px' })
    : null
  modal.laterGrid.replaceChildren(...list.map((item, i) => {
    const img = el('img', { src: item.thumb, alt: '' })
    img.loading = 'lazy'
    img.dataset.tags = item.tags
    if (item.webm) img.dataset.webm = '1'
    if (modal.laterIO) modal.laterIO.observe(img)
    const rm = el('button', { class: 'rm', text: '✕', title: t('laterRemoved') })
    const tile = el('div', { class: 'tile' }, [img, rm])
    if (item.webm || /\s(video|mp4|webm|animated|gif)\s/i.test(` ${item.tags} `)) tile.appendChild(el('span', { class: 'play', text: '▶' }))
    tile.addEventListener('click', ev => {
      if (ev.target === rm) return
      modal.listLinks = links
      modal.dir = 1
      openModal(links[i])
    })
    rm.addEventListener('click', async () => {
      const all = await laterList()
      await storeSet('later', all.filter(other => other.href !== item.href))
      info(`later: removed post ${postId(links[i])} from the list`)
      renderLater()
    })
    return tile
  }))
  dbg(`later: list shown, ${list.length} posts`)
}

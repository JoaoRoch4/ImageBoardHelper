export const VERSION = '2.1.0'
export const SITE = location.hostname.replace(/^www\./, '')

// The site's thumbnail list. Gelbooru 0.2 sites (rule34, safebooru, xbooru)
// put their thumbnails in .image-list > span.thumb; gelbooru.com itself in
// .thumbnail-container > article.thumbnail-preview. item: the list's own
// children, a card or what holds one (on the Gelbooru 0.2 favorites, a bare
// span around span.thumb and its Remove link). The rest is the same:
// the card's <a> around an <img> with the tags in title or alt, the
// paginator's a[alt="next"], the file layout. scriptHosts: other hosts the
// site's own scripts come from, which blockAds lets through (gelbooru's
// jQuery); adSlots: the site's own ad boxes, hidden with the shared ones;
// theme: the site's own look among the themes (page/theme.ts), the default
// one and what the panel and the post viewer wear under "Site's own". suggest: where
// the site's own search box gets its tag suggestions, the typed word
// appended (JSON: [{label: "tag (count)", value, type}], or gelbooru's
// [{value, post_count, category}]).
export type SiteProfile = {
  list: string,
  card: string,
  item: string,
  scriptHosts: string[],
  adSlots: string[],
  theme: 'normal' | 'gelbooru',
  suggest: string,
}
const SITE_PROFILES: Record<string, Partial<SiteProfile>> = {
  'gelbooru.com': {
    list: '.thumbnail-container', card: 'article.thumbnail-preview', item: 'article', scriptHosts: ['https://ajax.googleapis.com'],
    // Clickadu's 300x250 spots (in fixed-size wrappers), the footer one, ExoClick's video slider.
    adSlots: ['center:has([id^="__clb-spot_"])', 'div:has(> [id^="__clb-spot_"])', '[id^="__clb-spot_"]', '.footerAd2', '.exo_wrapper', '[id$="-msg-video-slider-content"]'],
    theme: 'gelbooru',   // the site's own blue
    suggest: '/index.php?page=autocomplete2&type=tag_query&limit=10&term=',
  },
  'safebooru.org': { suggest: '/autocomplete.php?q=' },
}
export const PROFILE: SiteProfile = { list: '.image-list', card: 'span.thumb', item: 'span', scriptHosts: [], adSlots: [], theme: 'normal',
  suggest: '/public/autocomplete.php?q=', ...SITE_PROFILES[SITE] }   // suggest: rule34's and xbooru's
export const LIST = PROFILE.list                 // the list of thumbnails
const CARD = PROFILE.card                 // one thumbnail's wrapper, a child of the list
export const THUMB = `${LIST} ${CARD}`           // a card inside the list
export const ITEM = `${LIST} > ${PROFILE.item}`  // a child of the list: a card, or the span around one

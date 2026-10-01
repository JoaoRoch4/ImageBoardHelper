# Changelog

## 0.9.4

- Site pages: real videos (tags `video`, `mp4`, `webm`) get the site's blue
  `.webm-thumb` frame back where the page leaves it out, as on favorites; the
  cover copies it. GIFs are left unmarked, and a mark added to an "animated"
  post comes off if it turns out to be a GIF

## 0.9.3

- The video cover no longer hides the video mark: on Masonry cards it is
  inserted right after the picture, so the type icon and buttons paint on top;
  on site pages it copies the thumbnail's border (rule34's blue `.webm-thumb`)
- Site pages detect video by the `.webm-thumb` class before falling back to tags

## 0.9.2

- Upgrades (sample, original, GIF) on an `<img>` now go in `srcset` and leave
  `src` untouched. Swapping `src` hid the `thumbnail_` URL that Imagus and
  similar hover-zoom tools match on, so they stopped working on upgraded
  images; it also kept Masonry's Vue free to undo the swap

## 0.9.1

- Feed posts span the full screen width, cancelling the site's side padding;
  on the post page the image and the video fit the screen width

## 0.9.0

- `nativeFeed` (off): on the site's own pages (Gelbooru 0.2 markup,
  `.image-list span.thumb`) every thumbnail takes a full row and is swapped
  for the sample, or for the original when the post has no sample
- Video covers and inline GIFs also work on the site's own pages; the kind
  comes from the thumbnail's tags (`title`/`alt`), since there are no icons
- A video card that turned out to be a GIF is remembered by file hash, so the
  ten video URLs are not retried when Masonry rebuilds the card element

## 0.8.2

Found by inspecting the live page on the phone through `tools/ffrdp.js`:

- Masonry's default layout draws cards with `<v-img>` (a background-image,
  no `<img>`), so covers, inline GIFs and original thumbnails never acted on
  them. Cards are now read and updated through either form
- At most three video covers are open at once, with a queue: Firefox for
  Android decoded four videos at a time on the test phone, and the rest sat at
  "metadata" forever or failed with a decode error
- Masonry's rule34 scraper marks posts as video by tag, so some GIFs carry the
  video icon. When no video host answers, the cover now tries the card as a GIF
- `thumbParts` strips the doubled slashes rule34 uses (`//thumbnails//2389/`)
- **Test URLs** reads `<v-img>` cards and prefers one on screen

## 0.8.1

- Header aligned with Violentmonkey's metadata reference: `@inject-into page`
  (the default `auto` falls back to the sandbox under a strict CSP, which
  silently breaks the Fancybox hook and the userAgent override), `@noframes`
  (the panel no longer mounts inside iframes) and `@downloadURL` (a copy
  installed from a file now updates). Dropped `@source`, which Violentmonkey
  does not read

## 0.8.0

- GIFs play inline (`gifInline`, on): while a GIF card is on screen the
  original .gif, probed off-screen, replaces the still; leaving the screen puts
  the still back to free the decoded frames
- Video and GIF detection looks at every type icon on the card, not only the
  first; on yande.re and konachan the parent/children icon came first and
  hid the video icon
- Optional `originalThumbs` (off by default): visible thumbnails, on Masonry
  cards and on the site's own pages, are swapped for the original file. The
  extension is probed off-screen (jpg, png, jpeg) at most three at a time;
  videos, GIFs and the detail viewer are left alone. Technique from Booru
  Enhanced Dark Gallery
- `thumbParts` also accepts `/samples/DIR/sample_HASH` URLs
- rule34: video covers now walk five verified video mirrors (`api-cdn-mp4`,
  `api-cdn-us-mp4`, `ahri2mp4`, `nymp4`, `ws-cdn-video`) instead of one;
  `wimg` answers 403 for video files. `videoHost` became `videoHosts`
- Panel: warning lines in the log were unreadable (yellow on yellow) because
  the status-dot colours leaked onto log lines; long URLs in the log now wrap

## 0.7.0

- Code and documentation translated to English; `README.pt-BR.md` added
- Panel is bilingual at runtime with a language selector (automatic, Portuguese,
  English), persisted as `lang`
- Log lines stay in English by design, so bug reports are single-language
- Gesture state stores an i18n key instead of a literal string, so the label
  follows the chosen language

## 0.6.0

- Project renamed to Image Board Helper
- `localStorage` keys moved from `JMF_*` to `IBH_*`; options fall back to their
  defaults once after the update
- Console global moved from `window.__mobilefix` to `window.__ibh`
- Header gained `@homepageURL`, `@source` and `@supportURL`

## 0.5.0

- Status panel in Shadow DOM: resolved host, thumbnail mode, cover counts,
  Fancybox state and last gesture
- Log layer with levels and a 250-entry buffer; console mirror via `debug`
- Options persisted in `localStorage` (`IBH_CFG`), editable from the panel
- Diagnostics: test candidate URLs, clear host cache, copy log
- Console access through `window.__ibh`

## 0.4.1

- `forceRule34Api` now ships off: the HTML scraper sends the session cookie and
  honours the account blacklist, `filter_ai` and `post_threshold`

## 0.4.0

- Option to unlock the rule34 API path by removing `Firefox` from the
  `userAgent`, working around the `||` in `isRule34Firefox()`

## 0.3.0

- Image server resolution separated from the thumbnail host, with a list of
  thumbnail-only mirrors and a seven-day cache
- Video covers walk the candidate hosts instead of giving up on the first 404

## 0.2.0

- Single file: sharp thumbnails, video covers, Fancybox repair and gestures
- Video covers switched from a `<canvas>` frame grab to an overlaid `<video>`,
  removing the CORS dependency

## 0.1.0

- First version: gestures translated into synthetic keys and toolbar clicks

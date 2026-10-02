# Changelog

## 0.23.1

- The turned video is sized to the visible height (`100dvh`): `100vh` on Firefox
  for Android includes the space behind the address bar, so the turned video
  ran 64 px past the screen

## 0.23.0

- Modal: a wide video (e.g. 16:9) on a portrait screen is turned 90° to fill
  the screen, watched with the phone turned left (`rotateLandscape`, on).
  Swipes are mapped to the viewer's directions and the controls strip moves
  to the screen's left edge while turned. With the screen already landscape
  (auto-rotate on) nothing is turned; it re-checks on resize

## 0.22.0

- Modal buttons ♡ favorite and ▲ upvote, calling the same endpoints as the
  post page with the site's login cookie: `public/addfav.php?id=` (3 added,
  1 already there, 2 not logged in) and `index.php?page=post&s=vote&id=&type=up`
  (answers with the new score, shown next to ▲). A short message confirms

## 0.21.0

- The modal now opens every post on site pages, not only videos: GIFs animate,
  images show what the feed already has at once and swap to the original when
  it loads (tall comics scroll inside the modal)
- Swipe in the modal: sideways for the next/previous post (‹ › and the counter
  now cover every post on the page), down to close (from the top of a tall
  image). Drags on the video's control strip stay seeks
- Videos with no video tag and no `.webm-thumb` open as an image, while the
  modal quietly checks for an `.mp4`; if there is one it switches to the video

## 0.20.0

- Video modal (`videoModal`, on): on the site's own pages, tapping a video
  thumbnail plays it with sound in an overlay instead of opening the post page.
  ✕ closes, ↗ opens the post, ‹ › move to the previous/next video on the page;
  tapping outside the video or the Android back button closes it, leaving the
  page on that post. Covers are closed while it plays to free a decoder. Falls
  back to muted if the autoplay policy blocks sound
- rule34 video hosts are speed-ordered again (`api-cdn` first); the 0.14.0
  rollback had taken that change out along with the preview

## 0.19.0

- ★ button (`sortButton`, on) on search listings, on the site and on Masonry:
  adds `sort:score` to the current search (replacing any other `sort:`) or
  removes it, and reloads on the first page. Lit while the search is sorted by
  score. On Masonry the button group sits above Masonry's refresh button

## 0.18.2

- Fix: the feed buttons never showed. The panel host is mounted while the
  page is still parsing, before the post list exists, so the "is this a feed?"
  check failed once and was never repeated. The buttons are now added whenever
  the list shows up

## 0.18.1

- Feed buttons gain ⤒, jump to the top of the page

## 0.18.0

- Feed buttons ‹ › (`feedNav`, on, with `nativeFeed`): bottom-right corner,
  jump instantly to the start of the previous or next post, to skip a long
  comic. Inside a long post, ‹ first goes back to its start. They live in the
  panel's Shadow DOM host and show even with the panel turned off

## 0.17.0

- Memory management (`memorySaver`, on):
  - upgraded images that scroll two screens away go back to the thumbnail,
    with their height held so the page does not jump, and are upgraded again
    when they come back; before, a long feed kept every original decoded
  - videos inside nodes Masonry removes are unloaded, and the live-cover count
    is recounted from the document; it never came back down, so covers could
    stop appearing after Masonry rebuilt the grid
  - Masonry page changes (`history.pushState`/`popstate`) drop per-page state;
    leaving the page releases everything so the back-button copy is light, and
    returning to it starts the thumbnails over

## 0.16.1

- Feed: posts no longer overlap. The site injects
  `.thumb { max-height: <thumbnail size> !important }` from the account
  setting; the feed lifted width and height but not max-height, so any image
  taller than 250 px (comics most of all) spilled over the next post.
  Measured on the phone: 126 items, no overlap

## 0.16.0

- Video thumbnails are upgraded too: video posts have no sample, so they are
  swapped for the site's full-size poster frame (`images/DIR/HASH.jpg`, tens
  of KB). In a mostly-video listing almost every thumbnail stayed a stretched
  250 px image, which is why "nothing gets replaced"
- Up to six upgrades at once (was three), and each new image is decoded off
  the main thread (`decode()`) before it is swapped in, so the feed does not
  stall while large files decode

## 0.15.1

- Video covers show the frame at 35% of the video (past intros and title
  cards) instead of the one at 1 s
- Fix: with the panel open, drawing the status called `touch()`, which drew
  the status again, until "too much recursion". The status list at the top of
  the panel failed silently because of it, and **Redo thumbnails** threw it.
  The panel now reads Masonry's settings without notifying, and the status
  render cannot re-enter

## 0.15.0

- On top of the 0.14.0 rollback, two panel buttons:
  - **Redo thumbnails** starts every thumbnail over, failures included:
    upgrades go back to the thumbnail and are queued again, covers and GIFs
    restart, and what is on screen is processed again right away
  - **Free memory & cache** is back: closes video covers, puts animated GIFs
    back to their still, undoes upgrades, and clears the host cache and the
    site's Cache Storage
- Console: `__ibh.redo()` and `__ibh.free()`

## 0.14.0

- Rollback to the 0.9.4 code, before the thumbnail video preview: removes the
  hold/drag preview (0.10.0–0.13.0), and with it the **Free memory & cache**
  button (0.12.0) and the speed-ordered rule34 video hosts (0.13.0). The
  version number moves forward so Violentmonkey installs it

## 0.13.0

- The thumbnail preview is now **hold for random frames**: holding a finger on
  a video thumbnail for 0.25 s jumps between random points of the video (5% to
  95%) every 0.4 s until the finger lifts, with the bar and time showing where
  it is. Lifting does not open the post or the long-press menu; moving first
  counts as a scroll. Replaces the sideways drag and the 2x autoplay
- rule34 video hosts reordered by speed measured from the phone: `api-cdn`
  (0.4 s to first byte, 0.3 s per MB, all test files present) now comes first;
  `api-cdn-mp4`, previously first, was the slowest (1.9 s / 2.9 s). Covers and
  thumbnail previews start several times faster
- The shared preview video takes a slot of the decoder budget, closing another
  card's cover if all are taken, instead of waiting for a free decoder; it is
  reserved only once a hold is confirmed, so scrolling does not churn covers

## 0.12.0

- Panel button **Free memory & cache**: closes video covers and the preview,
  puts animated GIFs back to their still, undoes sample/original upgrades, and
  clears the host cache and the site's Cache Storage. Settings, Masonry's
  settings and the login are kept; the browser HTTP cache cannot be reached
  from a page script. Also on the console as `__ibh.free()`

## 0.11.0

- After a scrub, the thumbnail keeps playing on its own from where the finger
  lifted: muted, looping, at 2x, with the progress bar following playback. One
  preview at a time on the same video element; it stops when the card leaves
  the screen or another card is touched, and a new drag on the same card
  pauses it, picks a new point and resumes from there

## 0.10.1

- Faster video scrub: the file starts loading on touch-down instead of after
  the drag is recognised, and is dropped if the touch turns into a scroll or a
  tap; a cover is reused even while still loading instead of opening a second
  download; the drag threshold went from 12 to 8 px

## 0.10.0

- Video scrub (`videoScrub`, on): dragging a finger sideways across a video
  thumbnail shows the frame at that point (left = start, right = end), with a
  progress bar and the time. Works on Masonry cards and on the site's own
  pages. It seeks the card's cover when one is open, otherwise a single shared
  `<video>` released on lift; one seek at a time with `fastSeek`. Vertical
  drags still scroll, and lifting after a scrub does not open the post

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

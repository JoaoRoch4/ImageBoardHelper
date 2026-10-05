# Changelog

## 0.41.0

- Tags menu: holding a tag opens its search in a new tab (a tap still copies
  it); the chip lights up once held long enough
- ↗ (open the post page) opens it in a new tab, so the modal and the page
  stay where they are

## 0.40.3

- Site theme lines in neon green (`#39ff14`): element borders, fields,
  buttons, paginator links, separators and the focus ring

## 0.40.2

- More contrast in the site theme: fields, buttons and paginator links stand
  on a lighter surface with a border that reads against the page, buttons in
  teal, a teal ring on the focused field, brighter text and placeholders

## 0.40.1

- Site theme a little lighter: dark slate background (`#182125`) instead of
  near-black, with fields and borders lightened to match

## 0.40.0

- The modal's dark theme on the site's own pages (`siteTheme`, on; applies at
  once from the panel): near-black background, light text, teal links,
  buttons, fields and paginator, and the sidebar's tag kinds in the tags
  menu's colours. Masonry keeps its own interface; images, videos and the
  thumbnails' blue video frame are left alone

## 0.39.0

- ☰ menu in the modal (in the place of ↗, which moved into it): a sheet with
  the post's tags as a grid, artist, character and copyright first, each kind
  in its colour. A tap copies a tag, "Copy all" the whole list, ready to paste
  in a search. The thumbnail's tags show at once; the post page (already
  fetched for the favorite state) replaces them with the full list by kind.
  The menu follows the post while you swipe

## 0.38.2

- A tap on the empty area around a modal image closes the modal again: since
  images fit by `object-fit`, the black bars around them were part of the
  image and swallowed the tap

## 0.38.1

- Double-tap in the centre of the modal player toggles fullscreen, like
  YouTube; the sides still seek ±5 s

## 0.38.0

- Fullscreen button at the bottom right of the modal player, like YouTube's:
  it enters fullscreen (turning the screen for a wide video) and, in
  fullscreen, where the top bar is hidden, its icon changes and it exits

## 0.37.1

- Modal images fit the screen whole in either orientation: an image was drawn
  at full width, so in landscape a portrait image came out two to three
  screens tall with its top and bottom cut off. Only comics (more than 2.2
  times taller than wide) go full width and scroll now, and the fit is redone
  when the screen turns

## 0.37.0

- ↻ button in the modal turns the screen to the other orientation, for any
  post (image, GIF or video), and keeps it while you swipe through posts;
  pressed again it turns back. Firefox locks the orientation only in
  fullscreen, so the press enters fullscreen first; leaving fullscreen or
  closing returns to the automatic rule (landscape for wide videos)

## 0.36.3

- Closing the modal keeps the page on the last post shown: leaving the
  modal's history entry let Firefox put back the scroll it had saved (often
  the top), over the scroll that followed the modal. Scroll restoration is now
  manual while the modal is open, and the page is placed after the back step
## 0.36.2

- The page scrolls along under the modal: each step centres the post's
  thumbnail, so after going far the page is already there on close. Covers,
  GIFs and upgrades hold off while the modal is open, so the scroll loads
  nothing underneath; what is on screen comes back on close
## 0.36.1

- Modal ▲ lit for favorites too: the site never shows a past vote, but its
  own heart votes up as it favorites, so a favorite counts as upvoted. The
  modal's ♡ now votes up as it adds a favorite, the same way
## 0.36.0

- Modal ♡ and ▲ show the post's real state:
  - favorite: read from the post page (its heart icon), in the background, so
    a post already in your favorites shows ♥; posts on your own favorites page
    need no lookup, and the next post's state is fetched with the preload
  - upvote: the site keeps no visible trace of a vote, so votes made from the
    modal or from the site's own vote links are remembered per site (up to
    5000)
  - a lit ♥ pressed again removes the favorite, as the site's own heart does
## 0.35.0

- Next post loaded in the modal (`modalPreload`, on): once the post on screen
  has loaded, the next one in the direction of travel is fetched. An image or
  GIF is downloaded and decoded, so the swipe shows it at once instead of the
  thumbnail; a video gets its host found and its header read, so the swipe
  skips walking the hosts. One post ahead only, it shares the three download
  slots, and it is dropped when the modal moves on, closes or Free memory runs

## 0.34.3

- Hold slideshow always starts at 00:00 and steps from there (0%, 10% … 90%
  with the default jump). It used to start past the cover's frame (45%), which
  looked like a random time

## 0.34.2

- Cover count kept right during a scene preview: every cover the script
  closed was seen again as "removed from the page" and triggered a recount
  that left out the decoders lent to the preview, so covers could open past
  the phone's limit mid-preview. Videos already unloaded are now skipped, and
  the recount includes the lent decoders. The log no longer repeats
  "unloaded 1 videos removed from the page" for each closed cover

## 0.34.1

- At most three image downloads at a time, GIFs and sample/original upgrades
  together (upgrades alone used to run six, GIFs had no limit). A GIF waiting
  for a slot goes before queued upgrades

## 0.34.0

- Constant memory cleanup (part of `memorySaver`):
  - off-screen images, GIFs and covers are swept every 15 s and whenever a
    scroll ends, catching what the observers miss when the grid reflows
  - a hidden tab parks its covers and GIFs (a background tab decodes nothing
    anyway) and brings back the ones on screen when it is shown again
  - a scene preview frees memory before it starts: off-screen work is
    released and GIFs on screen stop until the preview ends
- Unloading every cover (modal, leaving the page, Free memory) no longer lets
  a queued cover take each slot as it is freed

## 0.33.0

- Hold slideshow jump and seconds are adjustable in the panel (shown in hold
  mode): `slideStep` jumps 5%, 10%, 20% or 25% of the video between scenes (20,
  10, 5 or 4 scenes per loop), and `slideDwell` keeps each scene 0.1 to 1 s.
  Both apply from the next hold, no reload

## 0.32.0

- Hold slideshow loads scenes in parallel: a second, hidden video seeks and
  downloads the next scene while the current one is on screen, and the two
  swap by opacity, so a scene shows as soon as the dwell ends instead of after
  a fresh seek. The helper borrows a decoder like the shared preview does
  (closing another card's cover if every slot is taken), and the slideshow
  carries on with one video if no decoder is free

## 0.31.2

- Faster hold slideshow:
  - 0.2 s per scene (was 0.3 s), and the hold starts after 0.2 s (was 0.25 s)
  - scenes not downloaded yet are fetched at once; the 180 ms wait that keeps a
    moving finger from queuing seeks does not apply when no finger is moving
  - on a card with a cover, the slideshow starts from the scene after the
    cover's frame, where the file is already downloaded, instead of from 5%
  - a scene still loading after 1.5 s is passed over (was 2.5 s)

## 0.31.1

- Faster hold slideshow: each scene now stays 0.3 s once painted (was 0.6 s)

## 0.31.0

- Scene preview gesture is now an option (`scrubMode`, panel select): drag
  sideways as before, or hold a video thumbnail still for 0.25 s to play its
  scenes as a slideshow, 5% to 95% in order and looping, each shown 0.6 s once
  painted. Lifting the finger stops it without opening the post; moving before
  the hold starts still scrolls. In hold mode the long-press menu is blocked on
  video thumbnails

## 0.30.4

- Faster scrub frames: a seek into a part of the file not downloaded yet took
  4-5 s on the phone (about 500 KB/s, a large chunk fetched per seek), so the
  frame lagged far behind the bar. A buffered target is now seeked at once;
  otherwise the seek waits until the finger rests (180 ms) and fetches only
  that spot instead of every position crossed. Scrubbing a cover switches it to
  download the whole file, so it answers instantly as it fills in

## 0.30.3

- Scrub bar and time show on site pages: they were inserted right after the
  picture, before the card's cover video, which then painted over them. They
  now sit on top (`z-index`), so the bar and time follow the finger while the
  scenes change

## 0.30.2

- Scrub on site pages: the thumbnail is an `<img>` in a link, and a sideways
  drag started the browser's drag-and-drop, which cancelled the touch, so the
  bar showed once and vanished (Masonry's CSS backgrounds were unaffected).
  Video thumbnails are no longer draggable and `dragstart` is cancelled on them

## 0.30.1

- Scene preview follows the finger: fastSeek lands on the nearest keyframe,
  and short clips often have one every several seconds, so the frame barely
  changed during a drag. Clips up to a minute now seek exactly; longer ones use
  fastSeek while the finger moves and an exact seek once it rests (150 ms)

## 0.30.0

- Scene preview, written from scratch (`videoScrub`, on):
  - dragging a finger sideways across a video thumbnail shows its scenes, with
    a progress bar and the time; vertical drags still scroll, and the click
    after a drag does not open the post or the modal
  - in the modal, dragging the seek bar shows a preview box with the frame and
    time above the finger; the main video jumps once, on release
- Both use the card's own cover when it is loaded, otherwise a single shared
  preview video (the URL cache's winner first), so a preview never costs more
  than one decoder; with every cover slot taken it borrows the farthest
  cover's and gives it back on release. Seeks use fastSeek, one at a time

## 0.29.1

- Modal video controls are lighter (80% opacity, fainter background) and fade
  after 2 s without interaction while playing; they stay up while paused or
  while seeking. With them hidden, a tap on the video only brings them back;
  with them shown, it plays or pauses as before

## 0.29.0

- Modal video has its own controls — play/pause, time, a draggable seek bar
  and sound — always visible on the bottom strip, fullscreen included. The
  native controls are gone: they swallowed touches and their bar stayed hidden
  behind the gesture layer, worst in fullscreen
- Fullscreen shows only the post: the bar and the ‹ › buttons hide; a single
  tap on an image toggles them (double tap is still zoom). Video keeps its
  controls visible
- Fullscreen video that Firefox turns back to portrait is locked to landscape
  again

## 0.28.5

- The modal's ⛶ fullscreen now works for images and GIFs too: fullscreen goes
  to the whole modal, so the bar, swipes, zoom and the video's gesture layer
  all come along. The native video fullscreen button is handed to the modal
  the same way. Landscape is locked only while a wide video is shown; swiping
  to an image unlocks it and no longer leaves fullscreen

## 0.28.4

- Modal: posts whose only clue is the "animated" tag (no gif, no video/mp4/webm,
  no `.webm-thumb`) load the video and probe the `.gif` at the same time;
  whichever answers first wins and the other is cancelled. GIFs that took about
  3 s (every video host answering "missing" first) now show in about the time
  of one request

## 0.28.3

- Modal: a post treated as video (tag "animated" without "gif") whose video
  files all come back missing now falls back to its `.gif` instead of showing
  "No video with supported format and MIME type found"; the outcome is cached,
  so the next open goes straight to the GIF. Network and decoder errors still
  show the failure, since they say nothing about the file

## 0.28.2

- URL cache no longer trusts a single run of failures: a Wi-Fi handoff fails
  every ladder in flight, and the misses it wrote hid real files for a day —
  worst for covers, where it marked the post as a GIF and the modal then opened
  a video as a still. Now nothing is stored while offline, a video network
  error (code 2) is never a miss and never makes a cover fall back to GIF, and
  a miss is honoured only when it repeats at least a minute later
- A cover remounting with the same winning URL no longer reschedules a write
  of the whole cache

## 0.28.1

- Broken GIFs are rebuilt: after the swap the `<img>` is watched, and an error
  or a "load" with zero width (how a dropped decode shows up under memory
  pressure) frees what is off screen — upgraded images back to the thumbnail,
  other GIFs stilled, covers closed — then loads the GIF again, twice at most.
  The modal's GIF is reloaded the same way. CSS backgrounds (Masonry's default
  `<v-img>` layout) give no signal, so they are not covered

## 0.28.0

- URL cache (`urlCache`, on): the winning candidate URL is remembered per kind
  (original, sample, poster, GIF, video) and file hash, plus "nothing loads"
  for a day. Upgrades, covers, inline GIFs and the modal put the remembered URL
  first; if it fails the full ladder runs behind it and the new winner replaces
  it. A decode error ("no decoder free") is never stored as a miss. Expired
  entries delete themselves on load and on every write; at most 1500 are kept,
  oldest out first, and writes are batched every 3 s and on pagehide.
  Redo thumbnails drops the stored misses; Clear host and Free memory & cache
  drop everything. Console: `__ibh.urlCache()`, `__ibh.clearUrlCache()`

## 0.27.1

- Video gestures in fullscreen: the native controls' fullscreen button puts
  the bare `<video>` in fullscreen, leaving the gesture layer behind, so double
  tap, hold and tap did nothing there. Fullscreen is now handed to the wrapper
  holding the video and the layer, with the video filling it so the native
  controls stay on the bottom strip. A ⛶ button in the modal bar enters it
  directly. Swiping to an image leaves fullscreen

## 0.27.0

- Opening the modal unloads the page underneath: video covers close, animated
  GIFs go back to their still, upgraded images return to the thumbnail with
  their heights held, and pending upgrades are dropped (one finishing while the
  modal is open is discarded). On close, whatever is on screen loads again

## 0.26.0

- Feed buttons gain ⤓ (bottom of the page) and « » (previous/next page), now in
  two rows. The page buttons follow the site's own paginator, reading the
  address from href or, on favorites, from the onclick; without one they step
  pid by the number of posts on the page. « is dimmed on the first page

## 0.25.2

- Fix: video gestures in the modal never fired with a real finger. Firefox's
  native video controls swallow touches on the video and only toggle their
  bar; the synthetic test events had been dispatched straight to the element.
  A transparent layer over the video now takes the gestures (tap to play or
  pause, hold for 2x, double-tap a side for ±5 s, swipes), leaving the bottom
  strip uncovered so real taps there still reach the native controls

## 0.25.1

- Wide videos are no longer turned with CSS outside fullscreen; only the
  player's own fullscreen turns the screen to landscape. Swipes and taps use
  plain screen directions again
- Hold for 2x: the browser's long-press media menu is blocked inside the modal,
  since it cancelled the touch halfway through the hold. Each step of the video
  gestures and fullscreen now writes a debug log line, to see where it stops

## 0.25.0

- Modal video gestures: hold on the video for 2x while the finger stays down
  (a "2×" badge shows; lifting returns to normal speed and does not change
  post); double-tap on the right or left third jumps 5 s forward or back.
  The control strip is left alone, and with a turned video the sides follow
  the viewer

## 0.24.0

- Modal images zoom: pinch (1x to 6x, the point between the fingers stays put),
  one-finger pan while zoomed, double-tap to zoom 2.5x on that spot or back to
  1x. Swipes do not change post while zoomed; zoom resets on the next post or
  on close. The modal takes touches itself, which also disables the browser's
  zoom, and that one would have scaled the whole page anyway

## 0.23.2

- Modal fullscreen: entering the player's own fullscreen with a wide video
  locks the screen to landscape (Screen Orientation API, allowed by Firefox
  only in fullscreen) and unlocks it on exit; the CSS turn is off meanwhile so
  the rotations do not add up. Closing the modal leaves fullscreen first

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

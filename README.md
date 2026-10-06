# Image Board Helper

[Português](README.pt-BR.md) · **English**

A userscript for phones on Gelbooru 0.2 boards — rule34.xxx, safebooru and xbooru: an in-page post viewer, a sharp feed with columns, real video covers and scene previews, inline GIFs, search bars with saved searches, a search across your favorites, an autopager, Watch later and downloads, all with an eye on the phone's memory.

It works on the site's own pages and calls only the site's own endpoints. Up to 0.64 it was a companion to [Yande.re Masonry](https://github.com/asadahimeka/yandere-masonry); that version lives on in the [`masonry-companion`](https://github.com/JoaoRoch4/ImageBoardHelper/tree/masonry-companion) branch.

---

## What it does

- **Post viewer.** A tap on a thumbnail opens the post over the page: video with sound and its own controls, GIF, image (tall comics scroll, pinch to zoom). Swipe to the next post, favorite and upvote, tags, info and comments, download, Watch later. See `videoModal` below.
- **Feed.** One to four columns or automatic, whole images or even tiles, upgraded to the sample: as sharp as a phone screen shows, at a fraction of the original's size.
- **Video covers.** A `<video muted preload="metadata">` over each video thumbnail shows a real frame. The browser paints it and nothing is read back, so CORS never enters the picture, unlike grabbing the frame through a `<canvas>`. A few at a time: the phone decodes about four videos at once.
- **Scene preview.** Drag a finger across a video thumbnail to see its scenes, or hold it for a slideshow.
- **GIFs** animate while on screen, a few at a time.
- **Search.** On the listing pages, a bar with kind, order, minimum score and an OR field; saved and recent searches; a search across your own favorites; an autopager on listings and favorites; mass favorite.
- **Memory.** What scrolls far away goes back to the thumbnail, hidden tabs park their videos, and one button frees everything.

---

## Install

1. Install [Violentmonkey](https://violentmonkey.github.io/). Firefox for Android is what runs reliably today.
2. Open the raw link so Violentmonkey offers to install:

```
https://raw.githubusercontent.com/JoaoRoch4/ImageBoardHelper/main/image-board-helper.user.js
```

**Coming from the storage bridge** (`ibh-storage-bridge.user.js`, up to 0.64): its job is now part of this script. Keep the bridge installed until the first page load of 1.0 has brought its lists over (Watch later, the favorites index, saved searches; the log says "moved in from the storage bridge"), then uninstall it.

---

## Status panel

A round button in the bottom-left corner opens the panel. It shows the site, the resolved image host and the cover counts (ok / failed / total). Options are persisted, so every feature can be turned on and off without editing the file.

The panel has a language selector: Automatic, Português or English. Log lines stay in English on purpose — they exist to be pasted into issues, and a bilingual bug report is worse than an English-only one.

Useful actions:

- **Test URLs** — takes the first video card on screen and tests each candidate URL, logging OK or FAIL per host. The quick way to find out which server actually carries the files.
- **Clear host** — drops the seven-day cache and resolves again, for when the CDN moves.
- **Copy log** — builds a report with the version, `userAgent`, host and the history.
- **Redo thumbnails** — starts every thumbnail over, failures included: upgrades go back to the thumbnail and are queued again, covers and GIFs restart, and what is on screen is processed again right away.
- **Free memory & cache** — stops a scene preview in progress, closes video covers, puts animated GIFs back to their still (loading ones included), undoes sample/original upgrades, queued and in flight (what is on screen reloads from the browser cache), and clears the host cache, the URL cache and the site's Cache Storage. Other tabs of the same site running the script do the same. The browser's HTTP cache is out of reach for a page script (it lives on disk, not in RAM); settings and the site login are kept.

The panel uses Shadow DOM, so the site's CSS cannot reach it; touches inside it never start a scene preview (checked via `composedPath`).

---

## Options

All of them live in the panel and are stored in `localStorage` under `IBH_CFG`.

| Option | Default | Effect |
|---|---|---|
| `videoCovers` | on | overlays the real video frame on video thumbnails, a few at a time |
| `memorySaver` | on | images two screens away go back to the thumbnail (upgraded again on return), videos taken out of the page are unloaded, and everything is released when the page is left. Off-screen images, GIFs and covers are also swept every 15 s and after each scroll, a hidden tab parks its covers and GIFs, and a scene preview frees memory before it starts (needs reload) |
| `urlCache` | on | remembers which candidate URL worked for each file (original, sample, poster, GIF, video) and, for a day, which have none (a miss counts only when it repeats a minute later, and nothing is stored offline or on a network error), so images released by the memory saver or the modal come back with one request instead of walking every host and extension again. Expired entries delete themselves; at most 1500 are kept. **Redo thumbnails** drops the remembered misses, **Clear host** and **Free memory & cache** drop everything |
| `videoScrub` | on | drag a finger sideways across a video thumbnail to see its scenes (left = start, right = end); vertical drags still scroll and a tap still opens the post. In the modal, dragging the seek bar shows the frame under the finger (needs reload) |
| `scrubMode` | `drag` | scene preview gesture: `drag` picks the scene with the finger position; `hold` plays the scenes as a slideshow (from 00:00, looping, with the jump and seconds set by `slideStep` and `slideDwell`; a second hidden video loads the next scene in parallel) while a finger rests on the thumbnail for a moment, and lifting it stops without opening the post. In `hold` the long-press menu is blocked on video thumbnails |
| `slideStep` | `10` | hold slideshow: jump between scenes, in % of the video (5, 10, 20 or 25: 20, 10, 5 or 4 scenes per loop) |
| `slideDwell` | `0.2` | hold slideshow: seconds each scene stays once painted (0.1 to 1) |
| `slideReel` | on | hold slideshow from keyframes only, for MP4s: the script reads the file's index, fetches the keyframe at or before each scene (a few KB to a few hundred each) and plays them from memory in one video, so every scene after the first shows at once, with one decoder. The last four reels are kept for another hold (**Free memory & cache** drops them). A short clip (up to 30 s) with too few keyframes plays instead, muted, at 2× and looping; past the hardware decoder (1920×1088) even a few keyframes make a reel. WebM and anything unexpected fall back to seeking the file, or playing a short clip |
| `wasmDecode` | on | with `slideReel`, the keyframes are decoded in WebAssembly (FFmpeg's H.264 decoder, see Permissions) straight into a canvas, scaled to the card: no video element, no hardware decoder slot, and videos past the 1920×1088 hardware limit too. Each frame decodes while the one before is on screen (tens of ms on a phone). Off, or for streams it cannot decode, the reel plays in a video as before |
| `gifInline` | on | GIF cards animate while on screen and go back to the still when they leave; a GIF that breaks under memory pressure frees what is off screen and is rebuilt, twice at most |
| `gifMaxLive` | `3` | with `gifInline`, how many GIFs animate at once (1 to 10); the rest wait as stills and start, nearest the middle of the screen first, as others scroll away. Applies at once |
| `originalThumbs` | **off** | swaps visible thumbnails for the original file, only where the image shows wider than the 850 px sample in device pixels (a desktop screen), since the sample is as sharp as a phone can show (a comic page: 705 KB against a 51 MB original) (needs reload) |
| `holdRaw` | on | on site pages, holding an image thumbnail half a second loads its original (raw) file in place of the sample, with a RAW badge (holding again goes back to the sample); the release opens nothing, scrolling or pinching cancels. The browser's long-press menu is off on image thumbnails while it is on |
| `nativeFeed` | **off** | on the site's own pages (rule34, safebooru, xbooru and other Gelbooru 0.2 sites): a feed with the columns and layout below (one image per row at the full screen width by default), upgraded to the sample (or the original when there is none) (applies at once) |
| `feedColumns` | `1` | with `nativeFeed`: `auto` (as many 170px columns as the screen holds) or 1 to 4. Applies at once |
| `feedLayout` | `masonry` | with `nativeFeed` and more than one column: `masonry` keeps each image whole, in columns; `grid` makes even square tiles, cropped to fill. Applies at once |
| `feedNav` | on | with `nativeFeed`, round buttons in the bottom-right corner, in two rows: ⤒ top, ‹ › previous/next post (e.g. to skip a long comic), ⤓ bottom; « » (top left) previous/next page through the site's own pagination (needs reload) |
| `bulkFavButton` | on | on rule34 site pages (logged in), a ♥ button next to 🕒 turns on mass favorite: a tap on a thumbnail favorites and upvotes the post instead of opening it, and marks it ♥ (✕ on failure). Tap ♥ again to leave |
| `doubleTapFav` | on | on rule34 (logged in), a double tap on a thumbnail favorites and upvotes the post without opening it, and marks it ♥ (✕ on failure), as mass favorite does; a single tap still opens the post, about 0.3 s later (the wait for a second tap) |
| `favsButton` | on | on rule34 (logged in), a 🔖 button top right, beside ♥ and 🕒, opens your favorites page |
| `freeButton` | on | trash-can shortcut button with the floating buttons: one tap runs **Free memory & cache** (other tabs of the site included) |
| `redoButton` | on | ↻ shortcut beside the trash can: runs **Free memory & cache** on this tab, then **Redo thumbnails** (every thumbnail starts over, failures included) |
| `eyeButton` | on | a 👁 button bottom left, beside ◐: one tap hides every other floating button (◐, the feed buttons, 🗑 ↻, « », 🕒 ♥ 🔖) for a page with nothing over it, the next brings them back; remembered across pages. Hiding leaves mass favorite |
| `buttonsHidden` | off | set by the 👁 button, no panel switch |
| `laterButton` | on | on site pages, a 🕒 button in the top-right corner opens the **Watch later** list (posts saved from the 🕒 button in a post's ☰ menu) as a grid in the modal; a tap opens a post, the swipe walks the list, ✕ on a tile removes it. Kept in Violentmonkey's storage, on the device |
| `favSearch` | on | on your own rule34 favorites page, a search bar: `tag`, `-tag`, `tag*`, `a ~ b`, `score:>10`, filtered by kind (images, videos, GIFs, animated) and minimum score, and sorted by newest, oldest, score or random. Every favorite is indexed once (kept in Violentmonkey's storage) and later visits read only the new ones; results go into the page's own list, so the feed, the modal and the rest work on them. **Clear** brings the page back, **Rebuild index** reads every page again. every search joins a **Recent searches** list on its own, ☆ **Favorite** keeps one in **Favorite searches** (both also on the site bar), and the last favorites search comes back on the next visit |
| `favAutopager` | on | search listings and favorites pages (anyone's) load the next page as you near the bottom, and the modal's swipe carries on through it. The next address comes from each page's own paginator (on favorites it has no real links, which is why autopager extensions fail there) |
| `siteSearch` | on | on the site's listing pages and its home page (in place of the plain box), a search bar: tags, an OR field (tags apart by spaces become `( a ~ b ~ c )`), kind (images, videos, GIFs, animated), order (newest, score or random) and minimum score, turned into the site's own search (`score:>=N`, `sort:score`, `sort:random`, `( a ~ b )`) and read back from the address |
| `videoModal` | on | on the site's own pages, tapping a thumbnail opens the post in a player over the page: videos with sound and the player's own controls (play/pause, time, seek bar, sound, fullscreen at the bottom right like YouTube's; they fade after 2 s and a tap brings them back; tap to play/pause, hold for 2x, double-tap the right or left side for ±5 s, double-tap the centre for fullscreen), GIFs animated, images in the original (tall comics scroll; pinch to zoom, one finger pans while zoomed, double-tap for fullscreen (or back to 1x when zoomed), hold to open the ☰ menu). Swipe sideways or ‹ › for the next/previous post (the page scrolls along underneath, loading nothing until close), swipe down, ✕ or the back button to close, ☰ opens a menu with the post's tags as a grid (artist, character and copyright first, each in its colour; a tap copies one, a hold opens its search in a new tab, "Copy all" the list) and ↗ to open the post page in a new tab, with an Info tab (kind, resolution, format, duration, dropped frames, the post's statistics) and a Comments tab (▲ upvotes a comment, the author's name opens their profile); a tap outside closes the menu, ⛶ fullscreen for any post, ↻ turns the screen to the other orientation for every post until pressed again (enters fullscreen, where Firefox allows it), showing only the post: a tap on an image brings the bar back, video keeps its controls, ♡ favorites and ▲ upvotes it (showing the new score); both show the post's state when it opens: ♥ for a post already in your favorites (read from the post page), ▲ lit for a favorite (the site's heart votes up as it favorites, and so does ♡) or one you upvoted from the modal or the site's vote links (remembered on the device), and a lit ♥ pressed again removes the favorite. Videos without any video tag are detected and switch the player to video. While it is open the page underneath releases its covers, GIFs and upgraded images, which come back on close (needs reload) |
| `rotateLandscape` | on | in the modal player's own fullscreen, a video wider than tall locks the screen to landscape; outside fullscreen nothing is turned |
| `modalPreload` | on | in the modal, once the post on screen has loaded, the next one in the direction of travel is fetched: an image or GIF downloaded and decoded, so the swipe shows it at once; a video's host found and its header read, so it starts sooner. One post ahead only |
| `vlcButton` | on | in a video post's ☰ menu, **▶ VLC** opens the video in the VLC app from where the modal was (an intent link; without the app, its store page). VLC decodes natively on every core, so videos past the phone's hardware decoder play there; the modal says so when one opens. VLC for Android cannot send the site as Referer, which rule34's fast video host wants, so it gets the slower origin host |
| `modalOriginal` | `zoom` | images in the modal: `zoom` shows the sample at once (sharp at screen size) and loads the original when you zoom in, keeping the zoom (a SAMPLE / RAW button, bottom left, also switches by hand); `always` loads the original straight away (slower: originals run to tens of MB). Download saves the original either way |
| `siteTheme` | on | the modal's dark theme on the site's own pages: dark slate background, light text, teal links, buttons, fields and paginator, lines in neon green, tag kinds in colour. Applies at once |
| `lang` | automatic | panel language: automatic, Portuguese or English |
| `debug` | off | mirrors the log into the browser console |
| `panel` | on | floating button and panel |

### Storage

Settings live in `localStorage` (`IBH_CFG`), with a copy in Violentmonkey's storage and one in the site's IndexedDB that bring them back if another script clears `localStorage`. The lists (Watch later, the favorites index, saved searches) live in Violentmonkey's storage (`GM_getValue`/`GM_setValue`), on the device, so clearing the site's data does not take them. Under a userscript manager without GM storage they stay in the site's IndexedDB.

---

## Known limitations

**Thumbnail-only mirrors.** Some boorus serve thumbnails and files from different hosts, and certain mirrors do not carry the files. The list lives in `HOSTS` at the top of the script; only rule34 is mapped today. If covers fail on another site, use **Test URLs** in the panel to find the host and add it there.

---

## Permissions

- `GM_getValue`, `GM_setValue` — the lists and the copy of the settings (see Storage).
- `GM_xmlhttpRequest` with `@connect *` — the ⬇ Download button. A page script cannot read files from the image hosts, which send no CORS headers. The script only requests the site's own hosts (the site and its subdomains, such as `api-cdn.rule34.xxx`) and checks that before each download.
- `GM_getResourceURL` with `@resource h264dec` — the keyframe decoder for the hold slideshow: FFmpeg's H.264 decoder (LGPL 2.1+) built to WebAssembly from `wasm/h264dec.c` and `wasm/build.sh`, which pins the FFmpeg source by its hash. Violentmonkey downloads it once with the script, from a link pinned to a commit.
- `unsafeWindow` — puts `window.__ibh` on the page's own `window`, for the console; with GM grants the script's `window` is a wrapper around it.
- `@inject-into page` — runs the script in the page's own context, where it has always been tested on these sites; its calls to the site's endpoints (favorite, vote, comments, favorites pages) carry the site's login.

---

## Credits

- Started as a companion to [Yande.re Masonry](https://github.com/asadahimeka/yandere-masonry) by asadahimeka (MIT); that version is in the `masonry-companion` branch
- Image server resolution and the original-thumbnail probe inspired by Booru Enhanced Dark Gallery

## License

MIT. See [LICENSE](LICENSE).

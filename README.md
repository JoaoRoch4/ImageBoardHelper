# Image Board Helper

[Português](README.pt-BR.md) · **English**

A companion layer for the [Yande.re Masonry](https://github.com/asadahimeka/yandere-masonry) userscript, aimed at phones: touch gestures, sharp thumbnails, real video covers and a Fancybox repair.

It never modifies Masonry. It runs alongside it and talks through public surfaces only — keyboard events, DOM clicks and `localStorage`.

---

## What it fixes

**Stretched thumbnails.** Masonry's `getImgSrc` only swaps `previewUrl` for `sampleUrl` when `isThumbSampleUrl || (columns != 0 && columns < 7)`. With columns set to "Automatic" the value is `0`, the condition never passes, and you are left with the small thumbnail scaled up — and automatic is the default. We enable `isThumbSampleUrl` before the app reads its settings, so the app itself picks the large URL, per site.

**Blurry video covers.** Video posts are excluded from that swap, because a video's `sampleUrl` is the `.mp4` itself and will not render inside an `<img>`. We overlay a `<video muted preload="metadata">` on the card: the browser paints the real frame and nothing is read back, so CORS never enters the picture — unlike grabbing the frame through a `<canvas>`. An `IntersectionObserver` makes sure only visible cards open a decoder.

**Fancybox showing nothing.** `fancyboxShow` builds its items as `src: e.jpegUrl || e.fileUrl`, but several adapters return `fileUrl: ""` on purpose: the URL only exists after the detail fetch, which only the native viewer triggers. We intercept `Fancybox.show`, fill the empty `src` values and install the extension ladder (`.jpeg → .jpg → .png → .gif`) that the native viewer has and Fancybox does not.

**No touch navigation.** Masonry listens for `keyup` on `window`. We translate gestures into synthetic key events and clicks on toolbar buttons, located by the `d` attribute of the icon `<path>`.

---

## Gestures

| Gesture | Action | How |
|---|---|---|
| Swipe left | next image | key `D` |
| Swipe right | previous image | key `A` |
| Swipe down | close | toolbar button |
| Double tap | favorite | key `F` |
| Pinch out | zoom in | toolbar button |
| Pinch in | zoom out | toolbar button |

A single tap keeps Masonry's original behaviour.

---

## Install

1. Install [Violentmonkey](https://violentmonkey.github.io/). Firefox for Android is what runs reliably today.
2. Install [Yande.re Masonry](https://greasyfork.org/scripts/444885).
3. Open the raw link so Violentmonkey offers to install:

```
https://raw.githubusercontent.com/JoaoRoch4/ImageBoardHelper/main/image-board-helper.user.js
```

4. Reload the page once. Masonry reads its settings at boot.

> **Requires:** "Listen for keyboard events" enabled in Masonry's settings, otherwise the navigation swipes do nothing.

---

## Status panel

A round button in the bottom-left corner opens the panel — away from Masonry's refresh FAB, which sits on the right.

It shows the resolved image host, thumbnail mode, cover counts (ok / failed / total), Fancybox state and the last recognised gesture. Options are persisted, so every fix can be turned on and off without editing the file.

The panel has a language selector: Automatic, Português or English. Log lines stay in English on purpose — they exist to be pasted into issues, and a bilingual bug report is worse than an English-only one.

Useful actions:

- **Test URLs** — takes the first video card on screen and tests each candidate URL, logging OK or FAIL per host. The quick way to find out which server actually carries the files.
- **Clear host** — drops the seven-day cache and resolves again, for when the CDN moves.
- **Copy log** — builds a report with `userAgent`, host, thumbnail mode and the history.
- **Redo thumbnails** — starts every thumbnail over, failures included: upgrades go back to the thumbnail and are queued again, covers and GIFs restart, and what is on screen is processed again right away.
- **Free memory & cache** — stops a scene preview in progress, closes video covers, puts animated GIFs back to their still (loading ones included), undoes sample/original upgrades, queued and in flight (what is on screen reloads from the browser cache), and clears the host cache, the URL cache and the site's Cache Storage. Other tabs of the same site running the script do the same. The browser's HTTP cache is out of reach for a page script (it lives on disk, not in RAM); settings and the site login are kept.

The panel uses Shadow DOM because Masonry's CSS is aggressive with `!important` on `html, body`. Touches inside it are ignored by the gesture layer, via `composedPath`.

---

## Options

All of them live in the panel and are stored in `localStorage` under `IBH_CFG`.

| Option | Default | Effect |
|---|---|---|
| `sharpThumbs` | on | enables "thumbnail uses large image" (needs reload) |
| `videoCovers` | on | overlays the real video frame, on Masonry cards and on the site's own pages |
| `memorySaver` | on | images two screens away go back to the thumbnail (upgraded again on return), videos Masonry removes are unloaded, and everything is released when the page is left. Off-screen images, GIFs and covers are also swept every 15 s and after each scroll, a hidden tab parks its covers and GIFs, and a scene preview frees memory before it starts (needs reload) |
| `urlCache` | on | remembers which candidate URL worked for each file (original, sample, poster, GIF, video) and, for a day, which have none (a miss counts only when it repeats a minute later, and nothing is stored offline or on a network error), so images released by the memory saver or the modal come back with one request instead of walking every host and extension again. Expired entries delete themselves; at most 1500 are kept. **Redo thumbnails** drops the remembered misses, **Clear host** and **Free memory & cache** drop everything |
| `videoScrub` | on | drag a finger sideways across a video thumbnail to see its scenes (left = start, right = end), on Masonry and on the site's own pages; vertical drags still scroll and a tap still opens the post. In the modal, dragging the seek bar shows the frame under the finger (needs reload) |
| `scrubMode` | `drag` | scene preview gesture: `drag` picks the scene with the finger position; `hold` plays the scenes as a slideshow (from 00:00, looping, with the jump and seconds set by `slideStep` and `slideDwell`; a second hidden video loads the next scene in parallel) while a finger rests on the thumbnail for a moment, and lifting it stops without opening the post. In `hold` the long-press menu is blocked on video thumbnails |
| `slideStep` | `10` | hold slideshow: jump between scenes, in % of the video (5, 10, 20 or 25: 20, 10, 5 or 4 scenes per loop) |
| `slideDwell` | `0.2` | hold slideshow: seconds each scene stays once painted (0.1 to 1) |
| `gifInline` | on | GIF cards animate while on screen and go back to the still when they leave; a GIF that breaks under memory pressure frees what is off screen and is rebuilt, twice at most |
| `gifMaxLive` | `3` | with `gifInline`, how many GIFs animate at once (1 to 10); the rest wait as stills and start, nearest the middle of the screen first, as others scroll away. Applies at once |
| `fixFancybox` | on | fills empty `src` in Fancybox |
| `gestures` | on | swipe, double tap and pinch |
| `originalThumbs` | **off** | swaps visible thumbnails for the original file on Masonry; on the site's own pages only where the image shows wider than the 850 px sample in device pixels (a desktop screen), since the sample is as sharp as a phone can show (a comic page: 705 KB against a 51 MB original) (needs reload) |
| `holdRaw` | on | on site pages, holding an image thumbnail half a second loads its original (raw) file in place of the sample, with a RAW badge; the release opens nothing, scrolling or pinching cancels. The browser's long-press menu is off on image thumbnails while it is on |
| `nativeFeed` | **off** | on the site's own pages (rule34, safebooru, xbooru and other Gelbooru 0.2 sites): a feed with the columns and layout below (one image per row at the full screen width by default), upgraded to the sample (or the original when there is none) (applies at once) |
| `feedColumns` | `1` | with `nativeFeed`: `auto` (as many 170px columns as the screen holds) or 1 to 4. Applies at once |
| `feedLayout` | `masonry` | with `nativeFeed` and more than one column: `masonry` keeps each image whole, in columns; `grid` makes even square tiles, cropped to fill. Applies at once |
| `feedNav` | on | with `nativeFeed`, round buttons in the bottom-right corner, in two rows: ⤒ top, ‹ › previous/next post (e.g. to skip a long comic), ⤓ bottom; « » previous/next page through the site's own pagination (needs reload) |
| `bulkFavButton` | on | on rule34 site pages (logged in), a ♥ button next to 🕒 turns on mass favorite: a tap on a thumbnail favorites and upvotes the post instead of opening it, and marks it ♥ (✕ on failure). Tap ♥ again to leave |
| `freeButton` | on | trash-can shortcut button with the floating buttons: one tap runs **Free memory & cache** (other tabs of the site included) |
| `laterButton` | on | on site pages, a 🕒 button in the top-right corner opens the **Watch later** list (posts saved from the 🕒 button in a post's ☰ menu) as a grid in the modal; a tap opens a post, the swipe walks the list, ✕ on a tile removes it. Kept in Violentmonkey with the storage bridge, otherwise in the site's data |
| `favSearch` | on | on your own rule34 favorites page, a search bar: `tag`, `-tag`, `tag*`, `a ~ b`, `score:>10`, filtered by kind (images, videos, GIFs, animated) and minimum score, and sorted by newest, oldest, score or random. Every favorite is indexed once (kept by the storage bridge) and later visits read only the new ones; results go into the page's own list, so the feed, the modal and the rest work on them. **Clear** brings the page back, **Rebuild index** reads every page again. every search joins a **Recent searches** list on its own, ☆ **Favorite** keeps one in **Favorite searches** (both also on the site bar), and the last favorites search comes back on the next visit |
| `favAutopager` | on | search listings and favorites pages (anyone's) load the next page as you near the bottom, and the modal's swipe carries on through it. The next address comes from each page's own paginator (on favorites it has no real links, which is why autopager extensions fail there) |
| `siteSearch` | on | on the site's listing pages, a search bar: tags, kind (images, videos, GIFs, animated), order (newest or score) and minimum score, turned into the site's own search (`score:>=N`, `sort:score`, `( a ~ b )`) and read back from the address |
| `videoModal` | on | on the site's own pages, tapping a thumbnail opens the post in a player over the page: videos with sound and the player's own controls (play/pause, time, seek bar, sound, fullscreen at the bottom right like YouTube's; they fade after 2 s and a tap brings them back; tap to play/pause, hold for 2x, double-tap the right or left side for ±5 s, double-tap the centre for fullscreen), GIFs animated, images in the original (tall comics scroll; pinch or double-tap to zoom, one finger pans while zoomed). Swipe sideways or ‹ › for the next/previous post (the page scrolls along underneath, loading nothing until close), swipe down, ✕ or the back button to close, ☰ opens a menu with the post's tags as a grid (artist, character and copyright first, each in its colour; a tap copies one, a hold opens its search in a new tab, "Copy all" the list) and ↗ to open the post page in a new tab, with an Info tab (kind, resolution, format, duration, dropped frames, the post's statistics); a tap outside closes the menu, ⛶ fullscreen for any post, ↻ turns the screen to the other orientation for every post until pressed again (enters fullscreen, where Firefox allows it), showing only the post: a tap on an image brings the bar back, video keeps its controls, ♡ favorites and ▲ upvotes it (showing the new score); both show the post's state when it opens: ♥ for a post already in your favorites (read from the post page), ▲ lit for a favorite (the site's heart votes up as it favorites, and so does ♡) or one you upvoted from the modal or the site's vote links (remembered on the device), and a lit ♥ pressed again removes the favorite. Videos without any video tag are detected and switch the player to video. While it is open the page underneath releases its covers, GIFs and upgraded images, which come back on close (needs reload) |
| `rotateLandscape` | on | in the modal player's own fullscreen, a video wider than tall locks the screen to landscape; outside fullscreen nothing is turned |
| `modalPreload` | on | in the modal, once the post on screen has loaded, the next one in the direction of travel is fetched: an image or GIF downloaded and decoded, so the swipe shows it at once; a video's host found and its header read, so it starts sooner. One post ahead only |
| `modalOriginal` | `zoom` | images in the modal: `zoom` shows the sample at once (sharp at screen size) and loads the original when you zoom in, keeping the zoom; `always` loads the original straight away (slower: originals run to tens of MB). Download saves the original either way |
| `siteTheme` | on | the modal's dark theme on the site's own pages: dark slate background, light text, teal links, buttons, fields and paginator, lines in neon green, tag kinds in colour. Masonry keeps its own interface. Applies at once |
| `forceRule34Api` | on | automatic, no panel switch: see below (needs reload) |
| `lang` | automatic | panel language: automatic, Portuguese or English |
| `debug` | off | mirrors the log into the browser console |
| `panel` | on | floating button and panel |

### Storage bridge (optional)

`ibh-storage-bridge.user.js` is a second, small userscript that keeps the Watch later list in Violentmonkey's own storage, on the device, so it survives clearing the site's data, and saves files for the modal's ⬇ Download button (`GM_xmlhttpRequest`, only from the site's own hosts; a page script cannot save files from the image hosts, which send no CORS headers; without the bridge the file opens in a new tab). It exists because the main script must keep `@grant none` (it patches the page's own objects) and GM storage needs a `@grant`; the two talk through events on `window`. Install it from <https://raw.githubusercontent.com/JoaoRoch4/ImageBoardHelper/main/ibh-storage-bridge.user.js>. Without it, the list, the favorites index and a copy of the settings stay in the site's IndexedDB (which a script clearing `localStorage` leaves alone); the first time the bridge answers, the lists move into it.

### About `forceRule34Api`

`isRule34Firefox()` reads:

```js
hostname == "rule34.xxx" && (UA contains "Firefox" || !credentialQuery)
```

Because of the `||`, Firefox falls into the HTML scraper even with an API credential filled in — and that adapter comes before the API one in `fetchPostsActions`. Removing the word `Firefox` from the `userAgent` makes the first half false, so the list reaches `booruAction`, which uses the API and returns a ready `file_url`.

**Your account filters come along.** The scraper sends the session cookie (`credentials: "include"`), so the site applies the account blacklist, `filter_ai` and `post_threshold`; the API goes to `api.rule34.xxx`, a different host, with no cookie. The site keeps those filters in cookies the page can read (`tag_blacklist`, `filter_ai`, `post_threshold`), and Masonry's booru client calls the API with the page's `fetch`, so the script filters the answer before Masonry parses it: correct URLs, and what the site would hide stays hidden. It only acts with an API credential set in Masonry; without one the scraper stays. There is no panel switch; `__ibh.set('forceRule34Api', false)` turns it off.

---

## Known limitations

**Sites with late detail.** On sankaku, anime-pictures, allgirl, hentaibooru and kusowanka the file URL is neither in the listing nor derivable from the thumbnail. From the outside there is no way to write into `store.imageList`, so on those sites the Fancybox fix has to go into the original script:

```js
async function showImgModal(index) {
  if (settings.useFancybox) {
    const img = store.imageList[index]
    if (!img.fileUrl) await handlePostDetail({ value: img })
    fancyboxShow(store.imageList, index)
    return
  }
  store.imageSelectedIndex = index
  store.showImageSelected = true
}
```

**Thumbnail-only mirrors.** Some boorus serve thumbnails and files from different hosts, and certain mirrors do not carry the files. The list lives in `HOSTS` at the top of the script; only rule34 is mapped today. If covers fail on another site, use **Test URLs** in the panel to find the host and add it there.

**Downloads.** On the scraper path the `fileUrl` the app stores is still derived from the thumbnail. Display is worked around from outside, but downloads use that value directly and it is not reachable from here.

---

## Why `@grant none`

Intercepting `Fancybox` and reading `window.Fancybox` both require the page's own realm. Any `@grant` puts the script in a sandbox where `window` is not the page's `window`, and none of it works. That is why the options live in the panel instead of `GM_registerMenuCommand`.

`@inject-into page` makes the same choice explicit: Violentmonkey's default `auto` falls back to the sandbox when a site's CSP blocks page scripts, which would break the same features silently.

---

## Credits

- [Yande.re Masonry](https://github.com/asadahimeka/yandere-masonry) by asadahimeka — MIT
- Image server resolution and the original-thumbnail probe inspired by Booru Enhanced Dark Gallery

## License

MIT. See [LICENSE](LICENSE).

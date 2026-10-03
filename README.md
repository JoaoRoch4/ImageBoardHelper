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
- **Free memory & cache** — closes video covers, puts animated GIFs back to their still, undoes sample/original upgrades (what is on screen reloads from the browser cache), and clears the host cache and the site's Cache Storage. The browser's HTTP cache is out of reach for a page script; settings and the site login are kept.

The panel uses Shadow DOM because Masonry's CSS is aggressive with `!important` on `html, body`. Touches inside it are ignored by the gesture layer, via `composedPath`.

---

## Options

All of them live in the panel and are stored in `localStorage` under `IBH_CFG`.

| Option | Default | Effect |
|---|---|---|
| `sharpThumbs` | on | enables "thumbnail uses large image" (needs reload) |
| `videoCovers` | on | overlays the real video frame, on Masonry cards and on the site's own pages |
| `memorySaver` | on | images two screens away go back to the thumbnail (upgraded again on return), videos Masonry removes are unloaded, and everything is released when the page is left (needs reload) |
| `urlCache` | on | remembers which candidate URL worked for each file (original, sample, poster, GIF, video) and, for a day, which have none (a miss counts only when it repeats a minute later, and nothing is stored offline or on a network error), so images released by the memory saver or the modal come back with one request instead of walking every host and extension again. Expired entries delete themselves; at most 1500 are kept. **Redo thumbnails** drops the remembered misses, **Clear host** and **Free memory & cache** drop everything |
| `videoScrub` | on | drag a finger sideways across a video thumbnail to see its scenes (left = start, right = end), on Masonry and on the site's own pages; vertical drags still scroll and a tap still opens the post. In the modal, dragging the seek bar shows the frame under the finger (needs reload) |
| `scrubMode` | `drag` | scene preview gesture: `drag` picks the scene with the finger position; `hold` plays the scenes as a slideshow (5% to 95%, looping) while a finger rests on the thumbnail for a moment, and lifting it stops without opening the post. In `hold` the long-press menu is blocked on video thumbnails |
| `gifInline` | on | GIF cards animate while on screen and go back to the still when they leave; a GIF that breaks under memory pressure frees what is off screen and is rebuilt, twice at most |
| `fixFancybox` | on | fills empty `src` in Fancybox |
| `gestures` | on | swipe, double tap and pinch |
| `originalThumbs` | **off** | swaps visible thumbnails, on Masonry and on the site's own pages, for the original file; sharper, but several times the data and memory (needs reload) |
| `nativeFeed` | **off** | on the site's own pages (rule34, safebooru, xbooru and other Gelbooru 0.2 sites): one image per row at the full screen width, upgraded to the sample (or the original when there is none) (needs reload) |
| `feedNav` | on | with `nativeFeed`, round buttons in the bottom-right corner, in two rows: ⤒ top, ‹ › previous/next post (e.g. to skip a long comic), ⤓ bottom; « » previous/next page through the site's own pagination (needs reload) |
| `sortButton` | on | ★ button on search listings (site and Masonry): adds `sort:score` to the current search, or removes it, and reloads on the first page; lit while the search is sorted by score (needs reload) |
| `videoModal` | on | on the site's own pages, tapping a thumbnail opens the post in a player over the page: videos with sound and the player's own controls (play/pause, time, seek bar, sound; they fade after 2 s and a tap brings them back; tap to play/pause, hold for 2x, double-tap the right or left side for ±5 s), GIFs animated, images in the original (tall comics scroll; pinch or double-tap to zoom, one finger pans while zoomed). Swipe sideways or ‹ › for the next/previous post, swipe down, ✕ or the back button to close, ↗ opens the post page, ⛶ fullscreen for any post, showing only the post: a tap on an image brings the bar back, video keeps its controls, ♡ favorites and ▲ upvotes it (showing the new score). Videos without any video tag are detected and switch the player to video. While it is open the page underneath releases its covers, GIFs and upgraded images, which come back on close (needs reload) |
| `rotateLandscape` | on | in the modal player's own fullscreen, a video wider than tall locks the screen to landscape; outside fullscreen nothing is turned |
| `forceRule34Api` | **off** | see below (needs reload) |
| `lang` | automatic | panel language: automatic, Portuguese or English |
| `debug` | off | mirrors the log into the browser console |
| `panel` | on | floating button and panel |

### About `forceRule34Api`

`isRule34Firefox()` reads:

```js
hostname == "rule34.xxx" && (UA contains "Firefox" || !credentialQuery)
```

Because of the `||`, Firefox falls into the HTML scraper even with an API credential filled in — and that adapter comes before the API one in `fetchPostsActions`. Removing the word `Firefox` from the `userAgent` makes the first half false, so the list reaches `booruAction`, which uses the API and returns a ready `file_url`.

**Off by default, on purpose.** The scraper sends the session cookie (`credentials: "include"`) and honours the account blacklist, `filter_ai` and `post_threshold`. The API goes to `api.rule34.xxx`, a different host, with no cookie: you gain a correct URL and lose your account filters.

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

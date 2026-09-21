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

Three useful actions:

- **Test URLs** — takes the first video card on screen and tests each candidate URL, logging OK or FAIL per host. The quick way to find out which server actually carries the files.
- **Clear host** — drops the seven-day cache and resolves again, for when the CDN moves.
- **Copy log** — builds a report with `userAgent`, host, thumbnail mode and the history.

The panel uses Shadow DOM because Masonry's CSS is aggressive with `!important` on `html, body`. Touches inside it are ignored by the gesture layer, via `composedPath`.

---

## Options

All of them live in the panel and are stored in `localStorage` under `IBH_CFG`.

| Option | Default | Effect |
|---|---|---|
| `sharpThumbs` | on | enables "thumbnail uses large image" (needs reload) |
| `videoCovers` | on | overlays the real video frame |
| `fixFancybox` | on | fills empty `src` in Fancybox |
| `gestures` | on | swipe, double tap and pinch |
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

---

## Credits

- [Yande.re Masonry](https://github.com/asadahimeka/yandere-masonry) by asadahimeka — MIT
- Image server resolution inspired by the `ImageServer` module in Booru Enhanced Dark Gallery

## License

MIT. See [LICENSE](LICENSE).

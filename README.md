# ImageBoardHelper

Userscripts for image boards (booru sites).

## Scripts

### `booru-masonry-mobile-fix.user.js`

Companion patch for the Booru Masonry userscript, aimed at mobile use. It adds:

- **Sharp thumbnails** — turns on Masonry's own `isThumbSampleUrl` setting before
  the app reads its config, so the large sample URL is used even when the column
  count is set to "automatic".
- **Real video covers** — overlays a muted `<video preload="metadata">` on video
  cards so the browser paints an actual frame (no canvas, no CORS), mounted and
  unmounted by an `IntersectionObserver` to spare mobile decoders.
- **Fancybox repair** — fills in the empty `src` values Masonry hands the
  alternative viewer, and adds the `.jpeg → .jpg → .png → .gif` fallback the
  native viewer already has.
- **Touch gestures** — swipe left/right to navigate, swipe down to close,
  double-tap to favourite, pinch to zoom in/out.

Gesture navigation requires Masonry's "monitor keyboard events" setting to be
enabled. Sites whose file URL only exists after a detail fetch (sankaku,
anime-pictures, allgirl, hentaibooru, kusowanka) still need the patch noted at
the bottom of the script.

## Install

Open the `.user.js` file with Tampermonkey / Violentmonkey installed, or paste
its contents into a new script.

# Video reducer in IBH: the phone server's part 2 and the userscript

Date: 2026-10-09. Status: design agreed in conversation on 2026-10-09;
waiting for the user's review of this document.

## Why

Posts above 1080p60 stay on the poster or stutter on the phone (SM6115:
hardware decode up to 1920×1088 and 489,600 macroblocks a second).
VideoReducer's `vreduce` converts them natively, with the phone's own
hardware encoder, into a fragmented MP4 at most 1920×1080 that plays while it
is written. Its spec
(`/root/VideoReducer/docs/superpowers/specs/2026-10-08-videoreducer-design.md`,
"the VideoReducer spec" below) fixes the HTTP contract and gives this
repository two pieces: the phone server routes (part 2 of
`docs/superpowers/specs/2026-10-07-phone-server-design.md`) and the
userscript side. This document designs both, plus a way to start the server
from Termux and from the home screen.

## What is already fixed

Taken as is from the VideoReducer spec, not repeated here:

- `vreduce probe|stream|file`, its progress and final JSON lines, its exit
  codes, its SIGTERM behaviour;
- the HTTP contract: `POST /video/reduce`, `GET /video/<id>`,
  `POST /video/cancel`, `POST /video/save`, `POST /video/batch`, and
  `GET /v/<key>.mp4` without the token;
- `playable` (`pos ≥ 1.2 × dur × (1 − speed) + 2`) and `eta_s`;
- the queue (one job at a time; `open` > `next` > batch; the newest `open`
  wins; a job not polled for 30 s is cancelled unless batch or "save when
  done");
- the cache (`~/.cache/vreduce/`, SHA-256 of the URL, `.part` then renamed,
  LRU at 2 GB) and the batch output (`<name>.1080p.mp4`);
- heat and battery (`termux-battery-status` before each job and every 30 s:
  above 42 °C `next` and batch wait, above 45 °C everything waits and
  `GET /video/<id>` says `"hot": true`, below 20 % while not charging `next`
  and batch wait);
- `video.log` beside `server.log`, one line per job event, never a URL;
- the failure table (IBH falls back to what it does today).

## Decisions taken with the user

1. **Manual start.** A video starts converting only when the user taps
   ⚡ Convert. Nothing is converted ahead (`next` stays in the server for
   later). A video already in the cache plays converted with no tap.
2. **The token is pasted into the panel**, once. The home-screen shortcut
   (below) puts it on the clipboard.
3. **Two download buttons.** ⬇ Download raw keeps saving the original;
   ⬇ Download 1080p asks the server to save the converted file.
4. **Starting the server:** one script, run as a command in Termux and as a
   Termux:Widget icon on the home screen.

## The server

### Shape

- `tools/video-reducer.mts`, new: the jobs, the queue, the cache, running
  `vreduce`, the heat and battery checks, `video.log`, and the `/v/`
  streaming. It exports the route handlers and a `serveMedia(req, res)`
  function; it has no HTTP server of its own.
- `tools/phone-server.mts`: a small router in front of today's dispatch.
  - `GET /v/<key>.mp4` goes to `serveMedia` before the token check (the
    capability exception of the contract).
  - `GET /video/<id>` maps to the `video/status` handler with `{id}`.
  - Every other route stays `POST /<name>` with a JSON body, as in part 1.
  - `video/*` handlers come from `video-reducer.mts`, so `ROUTES` keeps
    one table.
- `VERSION` of the server goes to 2.0.0.

### `POST /video/reduce`

As in the contract, plus one optional field this side needs for decision 1:

- `start: false` only looks up: when the URL has a running job or a cached
  file, the answer is that job (`{ok, id, state, stream}`); otherwise
  `{ok: true, state: "none"}` and nothing starts. The default stays `true`,
  so the contract's callers are unaffected.
- `url` must be `https:` and its host one of the boorus' (the same rule as
  the userscript's `siteFile`, on the hosts in the server's own list:
  rule34.xxx, gelbooru.com, safebooru.org, xbooru.com and their
  subdomains), so the server never fetches an arbitrary address for a
  caller that holds the token.

### Running `vreduce`

- `$VREDUCE`, by default
  `…/containers/fedora/rootfs/root/VideoReducer/build/vreduce`.
- `vreduce stream --url U --referer R --out <hash>.part.mp4`, in its own
  process group, with stdout read line by line into the job's state.
- Cancel and preempt: SIGTERM to the group, then SIGKILL after 5 s; the
  `.part` file is deleted.
- `done`: the `.part` is renamed and the job keeps its key; `failed` keeps
  the stage, the message and the HTTP status for `GET /video/<id>`.

### `/v/<key>.mp4`

- The key: 32 random bytes in hex, made per job, kept in memory with the
  job and the cache entry; unknown key → 404.
- Finished file: ordinary `Range` answers (`206`, `Content-Range:
  bytes a-b/size`), or `200`.
- Growing file: `Range: bytes=N-` within the written part → `206` with
  `Content-Range: bytes a-b/*`, from N to the current end; a range that
  starts past the end waits for the file to grow, up to 30 s, then `416`.
  No `Range` → `200`, chunked, following the file until the job ends.
- Every answer carries `Cross-Origin-Resource-Policy: cross-origin` and
  `Content-Type: video/mp4`. No CORS headers.

### `POST /video/save`

Copies to `/sdcard/Download/<name>.mp4` (`name` must match
`^[\w.-]{1,80}$`), or marks the job "save when done" and answers at once.
When the copy lands, a notification through the existing `notify`.

## The userscript

### Settings and panel

- `DEFAULTS.videoReducer: false`. Off, nothing below exists: no requests to
  `127.0.0.1`, no buttons.
- The token: a password field in the panel, **stored with
  `storeGet`/`storeSet` (Violentmonkey's storage), never in `IBH_CFG`**,
  whose copies sit in the site's `localStorage` and IndexedDB, readable by
  the site's scripts.
- A status line beside it, from `/status` when the panel opens:
  connected (with the server's version), not answering, or wrong token.
- Both `I18N` tables, a line in both READMEs, `@version`, `VERSION`,
  CHANGELOG.

### Talking to the server

`GM_xmlhttpRequest` (`@connect *` is already there), so CORS does not apply
and the page sees nothing. One helper, `reducerCall(route, body)`, adds the
token and turns failures into `{ok: false, stage, error}`.

### When ⚡ shows

- In the player, in place of today's "☰ → VLC" warning, on a video past the
  size rule (`pastDecoder`).
- In the ☰ sheet, on every video, for a 1080p video past 60 fps that
  stutters.
- When a post opens with the option on, one `POST /video/reduce` with
  `start: false`: a running job resumes its progress display, a finished one
  plays converted at once.

### Converting

1. Tap ⚡: `POST /video/reduce {url, referer, priority: "open"}`. `url` is
   the post's own file on the fast host (`modal.fileUrl`), `referer` the
   site's origin.
2. While that post is on screen, `GET /video/<id>` every 1.5 s. The button
   reads "⚡ 34% · ~20 s" (`pos/dur`, `eta_s`), or "cooling down" when the
   answer says `hot`, or "queued".
3. When `playable`: the `<video>` gets `src = http://127.0.0.1:8730/v/<key>.mp4`
   (the answer's `stream`). It resumes at the time the original was at, if
   that part is written (else at the start), playing or paused as it was,
   at the kept speed (`applyPlayRate`).
4. While the file grows, the seek bar and the times use the server's `dur`
   (the `<video>` knows only the written part); seeking past the written
   part stops at its end. A waiting badge shows when `currentTime` stays
   still within 0.5 s of the end of `buffered` while playing, since Gecko
   fires neither `waiting` nor `ended` there.
5. Leaving the post stops the polling; the server cancels the job 30 s
   later, unless it was saved.

### ⬇ Download 1080p

In the ☰ sheet while the post has a job. `POST /video/save
{id, name: "<site>_<post>.1080p"}`; the toast says "saved in Download" or
"will be saved when done" (the server's notification follows).

### Failures

Server down, wrong token, unknown id after one retry, or a failed job: the
original video stays, a short toast says so, and the log gets
`video reducer: <stage> <error>`. The ⚡ button shows "failed" for 3 s and
comes back.

### Delivery fallback (spike 2)

If spike 2 shows that Firefox blocks or prompts for `127.0.0.1` media in an
https page, the script reads `/v/<key>.mp4` by ranges through
`GM_xmlhttpRequest` and feeds a `MediaSource` (`video/mp4; codecs` from the
first fragment), appending as the file grows. Built only if spike 2 needs
it.

## Starting the server

- `node tools/phone-server.mts install-shortcuts`, beside `install-boot`,
  writes:
  - `~/.shortcuts/tasks/IBH servidor` (Termux:Widget's background folder, so
    no terminal opens): takes Termux's wake lock, makes the tmux session
    `ibh` if missing, starts the server window if `/status` does not answer
    (and waits up to 10 s), copies the token with `termux-clipboard-set`,
    and says "IBH server on · token copied" (or "already on") with
    `termux-toast`;
  - `$PREFIX/bin/ibh-servidor`, a link to it, for the Termux shell;
  - `~/.shortcuts/icons/IBH servidor.png`, its icon.
- The boot script and this one share the lines that start the window.
- Why a shortcut and not a restart loop: both times the server was found
  down, its tmux window was gone with no error in `server.log`; Android
  killed the process (Termux's own tmux server stayed up the second time).
  A loop inside the window dies with it.

## Spike 2 first

The first task of the plan, with the user and Nightly in front (it is the
VideoReducer spec's spike 2, done from here). The server from
`/root/VideoReducer/tests/fixture_server.py`, run natively, serves a growing
`vreduce` output with the `/v/` semantics; a rule34 tab plays it from
`127.0.0.1`. It settles: a local network prompt or block, the hardware
decoder on the growing stream, the stall-not-ended behaviour at the written
end, and the latency of `GM_xmlhttpRequest` to `127.0.0.1`.

## Testing

- **Server** (`node:test`, `npm run -s test:tools`), a real server against a
  fake `vreduce` (`$VREDUCE`: a script that prints progress lines at a set
  pace, writes a growing file, can fail at a stage, and obeys SIGTERM), a
  fake `termux-battery-status` (`IBH_TERMUX_BIN`), and a temporary cache:
  - reduce, status, playable, done, cancel, save, batch, `start: false`;
  - the queue: one at a time, priorities, the newest `open` cancelling the
    older, promotion, the 30 s interest timeout (shortened by an
    environment variable);
  - the cache: rename on done, `.part` cleanup at start, LRU trimming;
  - heat and battery thresholds;
  - `/v/`: no token needed, 404 for a wrong key, `206` with `bytes a-b/*`
    while growing, a range past the end that waits and then gets data, CORP
    on every answer;
  - the URL check (a non-booru host refused).
- **Userscript** (`npm run smoke`): `GM_xmlhttpRequest` swapped for a fake
  server that answers the routes. It checks: no request with the option
  off; ⚡ in the ☰ sheet; the progress text; the swap to the `stream` URL
  when `playable` (on a fixture video served by `page.route`); ⬇ Download
  1080p; the fallback and toast on a failed job. The size rule in the player
  is checked with a fixture past 1920×1088.
- **Shortcut:** a test runs the generated script against stub commands
  (`tmux`, `curl`, `termux-*` on `PATH`) and checks what it called.
- **Device:** the real chain on a post past 1080p60, with Nightly in front.

## Order of work

1. Spike 2 (with the user).
2. Server: router and `video-reducer.mts`, test first.
3. Shortcut: `install-shortcuts`, test first.
4. Userscript: settings, panel, ⚡, polling, swap, Download 1080p, failures,
   smoke first; then the `MediaSource` fallback if spike 2 asks for it.
5. Device run, docs (both READMEs, CLAUDE.md, the phone-workflow skill),
   version, deploy.

## Out of scope

Converting ahead (`next`), batch from the userscript (the route is there for
the terminal and the phone MCP), reaching the server over Wi-Fi (part 3 of
the phone server), seeking past the converted part, resuming a cancelled
job.

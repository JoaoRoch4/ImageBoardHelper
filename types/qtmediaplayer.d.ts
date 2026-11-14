// The contract between this script and the user's QtMediaPlayer app
// (JoaoRoch4/qtmobilemedia): a small HTTP server the app keeps on
// http://127.0.0.1:8745 while it runs (appBridge). The app's side follows
// these shapes; CLAUDE.md here and there describe the rules around them.
//
// - Every request carries `Authorization: Bearer <token>` (the token the
//   app shows in its settings; never in the URL). Without it, or wrong: 401.
// - Bodies are JSON (`Content-Type: application/json`), and so are replies,
//   which always have `ok`. No CORS headers and OPTIONS is refused, so a
//   page can't read a reply; the bearer token is what keeps other pages out.
// - The app answers only while Android lets it run: in the background
//   without a foreground service it is frozen and the port doesn't answer,
//   so a short timeout and the intent link are the client's fallback.

/** Every reply that isn't a success: 400 (bad body), 401 (token), 404 (no such route or id), 405, 500. */
interface AppError {
  ok: false
  /** What went wrong, in English, for the log. */
  error: string
}

/** GET /v1/status */
interface AppStatus {
  ok: true
  app: 'QtMediaPlayer'
  /** The app's version name. */
  version: string
  /** This contract's version: 1. */
  api: number
}

/** POST /v1/download's body. */
interface AppDownloadRequest {
  /** The file's http(s) link, the site's fast host included. */
  url: string
  /** Sent as Referer while downloading (rule34's fast video host wants the site). */
  referer?: string
  /** A name for the app's list and notification, e.g. "rule34 1234567". */
  title?: string
  /** Converted to 1080p once saved, if past the hardware decoder (⚡ 1080p). */
  reduce: boolean
}

/** POST /v1/download's reply: 202, queued. */
interface AppDownloadQueued {
  ok: true
  /** For GET /v1/download/<id>; valid while the app runs. */
  id: number
}

type AppJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

/** GET /v1/download/<id> */
interface AppDownloadState {
  ok: true
  id: number
  status: AppJobStatus
  /** 0 to 1; -1 while unknown. */
  progress: number
  /** The saved file's path, once done. */
  file?: string
  /** Why it failed. */
  error?: string
  /** For a download with reduce: the conversion, once one exists ('fits' when the video needs none). */
  reduce?: { status: AppJobStatus | 'waiting' | 'fits', progress: number }
}

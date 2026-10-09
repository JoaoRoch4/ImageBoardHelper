// Development helper, not part of the userscript.
//
// The phone server's video routes (part 2): VideoReducer's `vreduce`
// converts booru videos past the phone's hardware decoder, one at a time,
// into a growing fragmented MP4 that Firefox plays from /v/<key>.mp4. The
// HTTP contract is VideoReducer's spec
// (/root/VideoReducer/docs/superpowers/specs/2026-10-08-videoreducer-design.md);
// this side's design is
// docs/superpowers/specs/2026-10-09-video-reducer-integration-design.md.
// No HTTP server of its own: tools/phone-server.mts routes to it.
// TypeScript that Node runs as it is (it strips the types); tsc -p tools checks it.

import type * as http from 'node:http'
import { HttpError } from './http-error.mts'
import type { Handler } from './http-error.mts'

// What the server lends it: Termux's commands, its folder, the media folder.
export interface VideoDeps {
  termux(name: string, args: string[]): Promise<string>
  dir: string
  mediaDir: string
  notify(title: string, text: string): Promise<void>
}

// /v/ answers are read by a <video> in a booru page: allowed cross-origin.
const CORP = { 'cross-origin-resource-policy': 'cross-origin' }

export function makeVideoReducer(_deps: VideoDeps) {
  const routes: Record<string, Handler> = {
    'video/status': async () => { throw new HttpError(404, 'no such video') },
  }

  function serveMedia(_req: http.IncomingMessage, res: http.ServerResponse) {
    res.writeHead(404, { ...CORP, 'content-type': 'text/plain' }).end('no such video')
  }

  function stop() { /* jobs come with the queue */ }

  return { routes, serveMedia, stop }
}

// Development helper, not part of the userscript.
//
// What the phone server's modules share: the failure that carries its HTTP
// status, and the shape of a route (tools/phone-server.mts and
// tools/video-reducer.mts).
// TypeScript that Node runs as it is (it strips the types); tsc -p tools checks it.

// A failure with the HTTP status it answers with.
export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export type Handler = (body: Record<string, unknown>) => Promise<Record<string, unknown>>

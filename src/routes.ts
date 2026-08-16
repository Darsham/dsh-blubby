/**
 * blubby HTTP routes — the browser half talks to the host through plain
 * same-origin JSON endpoints (/api/blubby/*) and plays the pet videos from
 * the /blubby/* asset prefix.
 * @module dsh-blubby/routes
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { BlubbyService } from './index.ts'

/** Browser-facing base path of the blubby API routes. */
export const BLUBBY_API_PREFIX = '/api/blubby'

/** Browser-facing base path of the pet asset routes ('/blubby/<file>'). */
export const BLUBBY_ASSET_PREFIX = '/blubby'

/** The asset files the browser half may request (segment manifest). */
export const BLUBBY_ASSET_FILES = [
  'segments.json',
] as const

/** Frame files live under '<assets>/frames/'; names are generated as
 * '<state>_<segment>_<NN>.webp' — validate with a strict pattern. */
export const BLUBBY_FRAME_RE = /^[a-z]+_(initial|enter|doing|exit)_\d{2}\.webp$/

/** Absolute package root, resolved from a module URL (lib/ or src/). */
export function blubbyPackageRoot(importMetaUrl: string): string {
  return fileURLToPath(new URL('../', importMetaUrl))
}

/** The assets directory holding the video tracks. */
export function blubbyAssetsDir(importMetaUrl: string): string {
  return join(blubbyPackageRoot(importMetaUrl), 'assets', 'blubby')
}

/** Content type for one asset file, by extension. */
function mimeFor(file: string): string {
  if (file.endsWith('.webm')) return 'video/webm'
  if (file.endsWith('.png')) return 'image/png'
  if (file.endsWith('.jpg') || file.endsWith('.jpeg')) return 'image/jpeg'
  if (file.endsWith('.webp')) return 'image/webp'
  if (file.endsWith('.json')) return 'application/json; charset=utf-8'
  return 'application/octet-stream'
}

/** Require the request method; replies 405 and returns false otherwise. */
function requireMethod(req: IncomingMessage, res: ServerResponse, method: string): boolean {
  if (req.method === method) return true
  res.writeHead(405)
  res.end()
  return false
}

/** Reply one JSON body. */
function json(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-cache',
  })
  res.end(body)
}

/** Wrap one async service call as a GET JSON route. */
function getRoute(path: string, run: () => Promise<unknown>): WebRoute {
  return {
    kind: 'exact',
    path,
    handler: (req: IncomingMessage, res: ServerResponse): void => {
      if (!requireMethod(req, res, 'GET')) return
      run().then((value) => json(res, 200, value), (error) => {
        json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      })
    },
  }
}

/** Wrap one async service call as a POST JSON route (body passed through). */
function postRoute(path: string, run: (body: Record<string, unknown>) => Promise<unknown>): WebRoute {
  return {
    kind: 'exact',
    path,
    handler: (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (!requireMethod(req, res, 'POST')) return Promise.resolve()
      return readJsonBody(req).then((body) => {
        const record = (typeof body === 'object' && body !== null) ? body as Record<string, unknown> : {}
        return run(record).then(
          (value) => json(res, 200, value),
          (error) => {
            json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
          },
        )
      }, (error) => {
        json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      })
    },
  }
}

/** Read a JSON request body (bounded at 64 KiB). */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  return new Promise((resolve, reject) => {
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > 64 * 1024) {
        reject(new Error('body-too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid-json'))
      }
    })
    req.on('error', reject)
  })
}

/** Build the full route family (API + assets) for one service. */
export function makeBlubbyRoutes(deps: { service: BlubbyService; assetsDir: string }): WebRoute[] {
  const { service, assetsDir } = deps
  const apiRoutes: WebRoute[] = [
    getRoute(BLUBBY_API_PREFIX + '/state', () => service.state()),
  ]

  const assetRoute: WebRoute = {
    kind: 'prefix',
    path: BLUBBY_ASSET_PREFIX,
    handler: (req: IncomingMessage, res: ServerResponse): void => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405)
        res.end()
        return
      }
      let pathname: string
      try {
        pathname = new URL(req.url ?? '/', 'http://blubby.local').pathname
      } catch {
        res.writeHead(400)
        res.end()
        return
      }
      const segments = pathname.split('/').filter(segment => segment !== '')
      if (segments[0] !== 'blubby' || segments[1] === undefined) {
        res.writeHead(404)
        res.end()
        return
      }
      const name = decodeURIComponent(segments[1])
      // Whitelist: only the declared manifest is servable at the top level.
      if (!(BLUBBY_ASSET_FILES as readonly string[]).includes(name)) {
        // Frames live under '/blubby/frames/<file>' — validate strictly.
        if (name === 'frames' && segments[2] !== undefined) {
          const frame = decodeURIComponent(segments[2])
          if (!BLUBBY_FRAME_RE.test(frame)) {
            res.writeHead(404)
            res.end()
            return
          }
          const file = join(assetsDir, 'frames', frame)
          if (!existsSync(file)) {
            res.writeHead(404)
            res.end()
            return
          }
          readFile(file).then((body) => {
            res.writeHead(200, {
              'content-type': mimeFor(file),
              'content-length': String(body.byteLength),
              'cache-control': 'public, max-age=86400',
            })
            if (req.method === 'HEAD') {
              res.end()
              return
            }
            res.end(body)
          }, () => {
            res.writeHead(404)
            res.end()
          })
          return
        }
        res.writeHead(404)
        res.end()
        return
      }
      const file = join(assetsDir, name)
      if (!existsSync(file)) {
        res.writeHead(404)
        res.end()
        return
      }
      readFile(file).then((body) => {
        res.writeHead(200, {
          'content-type': mimeFor(file),
          'content-length': String(body.byteLength),
          'cache-control': 'public, max-age=86400',
        })
        if (req.method === 'HEAD') {
          res.end()
          return
        }
        res.end(body)
      }, () => {
        res.writeHead(404)
        res.end()
      })
    },
  }

  return [...apiRoutes, assetRoute]
}

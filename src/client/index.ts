/**
 * dsh-blubby browser half — mounts 小咕噜 as a global floating surface and
 * drives it from the host's same-origin '/api/blubby/*' JSON endpoints:
 * poll the host snapshot (~2 s), play the raw mp4 video for the active
 * track. The pet is host-global (no session dimension), so it mounts
 * directly onto 'document.body' via a single React root rather than a
 * session-scoped slot — on the new-conversation screen no session exists,
 * and a dock-mounted pet would vanish there (dsh-pet issue #48).
 * @module dsh-blubby/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { BlubbyStateView } from '../index.ts'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { BlubbyEntry, type BlubbyInjected } from './BlubbyEntry.tsx'

/** The host blubby API as the browser sees it (same-origin JSON endpoints). */
interface BlubbyHttpApi {
  state(): Promise<BlubbyStateView>
}

/** Same-origin JSON fetch helper. */
async function blubbyFetch<T>(path: string): Promise<T> {
  const response = await fetch(path)
  if (!response.ok) {
    throw new Error('blubby ' + path + ' failed: ' + response.status)
  }
  return (await response.json()) as T
}

/** The live host API instance (always defined; failures surface per call). */
const blubbyApi: BlubbyHttpApi = {
  state: () => blubbyFetch('/api/blubby/state'),
}

/** Poll interval for the host snapshot. */
const POLL_MS = 2000

/** Required services (none — the pet is pure fetch + DOM). */
export const inject: string[] = []

/**
 * Client plugin body: mount the global blubby entry and poll loop while the
 * plugin is enabled.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // The pet is host-global (its state has no session dimension), and the
  // official rc.6 shell declares no root-scoped slot for a global floating
  // surface — the dock is session-scoped, so a pet mounted there would vanish
  // on the new-conversation screen (issue #48). Mount straight onto
  // document.body via a single React root for the page lifetime.
  const container = document.createElement('div')
  container.dataset.dshBlubbyRoot = ''
  document.body.appendChild(container)
  const petRoot = createRoot(container)

  // The entry holds its own latest-snapshot state; the poll loop writes it.
  let latest: BlubbyStateView | null = null
  let failed = false
  const pollNow = (): void => {
    blubbyApi.state().then((snapshot) => {
      latest = snapshot
      failed = false
      render()
    }, () => {
      failed = true
      render()
    })
  }
  const render = (): void => {
    const injected: BlubbyInjected = {
      snapshot: latest,
      transportFailed: failed,
    }
    petRoot.render(createElement(BlubbyEntry, injected))
  }

  const disposePoll = ctx.effect(() => {
    // Poll only while the tab is visible: the host snapshot does not change
    // while the page is hidden, so a background interval would only burn
    // RPCs. Coming back to the tab refreshes the pet immediately.
    let timer: number | undefined
    const stop = (): void => {
      if (timer !== undefined) {
        window.clearInterval(timer)
        timer = undefined
      }
    }
    const start = (): void => {
      if (timer === undefined && document.visibilityState === 'visible') {
        timer = window.setInterval(pollNow, POLL_MS)
      }
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        pollNow()
        start()
      } else {
        stop()
      }
    }
    pollNow()
    start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, 'blubby: poll')

  ctx.effect(() => {
    return () => {
      petRoot.unmount()
      container.remove()
      disposePoll()
    }
  }, 'blubby: cleanup')
}

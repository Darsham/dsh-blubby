/**
 * tsdown config for dsh-blubby — builds the node half (lib/index.js) and the
 * browser client bundle (lib/client.js) in one pass.
 */
import { clientBundle } from './tsdown.client.ts'

export default clientBundle('dsh-blubby', ['src/index.ts'], {
  libExternal: [
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-host-webserver',
  ],
})

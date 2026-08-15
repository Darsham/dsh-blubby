/**
 * tsdown preset for the dsh-blubby plugin — the node-half lib build plus the
 * browser client bundle. Emits a closure-factory artifact: the bundle calls
 * window.__ModuleLoader__.load ({id, factory}) and resolves externals through
 * the injected require (loader module table — cordis DI entities, no
 * globals, no import map). The platform module list mirrors the shell's seed
 * table in ./web-platform.ts.
 * @module dsh-blubby/tsdown.client
 */

import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'
import { PLATFORM_MODULES } from './web-platform.ts'

/** Externals resolved from the loader module table: the platform seed entries. */
export const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES]

const REPOSITORY_ROOT = fileURLToPath(new URL('.', import.meta.url))

/** Rebase a physical path onto a repository-relative id when it lives under the repo. */
function repositoryRelativePath(physical: string): string {
  if (!isAbsolute(physical)) return physical
  const repositoryPath = relative(REPOSITORY_ROOT, physical).split(sep).join('/')
  return repositoryPath.startsWith('../') ? physical : repositoryPath
}

/**
 * Build the tsdown config for the plugin: the node-half lib build plus the
 * browser client bundle. Client packages emit both halves during the Client
 * pass by default.
 * @param id - plugin id (package name), stamped into the __ModuleLoader__.load handoff.
 * @param libEntry - node-half entries.
 */
export function clientBundle(
  id: string,
  libEntry: readonly string[],
  options: { libExternal?: readonly (string | RegExp)[] } = {},
): UserConfig[] {
  const lib: UserConfig = {
    name: id,
    entry: [...libEntry],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    // The cordis framework resolves at runtime from the dsh profile tree;
    // its built declarations carry .ts-suffixed relative imports rolldown
    // cannot follow, so the import must stay external.
    external: ['@deepseek-ai/cordis', ...(options.libExternal ?? [])],
  }

  const hasClient = existsSync(resolvePath(process.cwd(), 'src/client/index.ts'))
  if (!hasClient) return [lib]

  const client: UserConfig = {
    name: `${id}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    // Browser bundles inline node-idiom deps (zustand/immer read
    // process.env.NODE_ENV; zustand's esm build also probes
    // import.meta.env.MODE, which a CJS output cannot carry). The bare
    // `import.meta.env` key is required alongside the precise MODE key.
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    // tsdown auto-externalizes package dependencies; anything NOT in the
    // loader module table must inline instead. A require() the table cannot
    // answer is a guaranteed runtime throw.
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    outputOptions: {
      entryFileNames: 'client.js',
      sourcemapPathTransform: (source: string, sourcemapPath: string) => {
        if (!source.startsWith('.')) return source
        const physicalSource = resolvePath(sourcemapPath, '..', source)
        return repositoryRelativePath(physicalSource)
      },
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }

  return [lib, client]
}

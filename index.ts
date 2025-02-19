import { existsSync, mkdirSync, writeFile } from 'fs'
import { basename, dirname, resolve } from 'path'
import { createFilter, CreateFilter } from 'rollup-pluginutils'

import type { Plugin } from 'rollup'

export interface CSSPluginOptions {
  exclude?: Parameters<CreateFilter>[1]
  failOnError?: boolean
  include?: Parameters<CreateFilter>[0]
  includePaths?: string[]
  insert?: boolean
  output?: string | false | ((css: string, styles: Styles) => void)
  prefix?: string
  processor?: (
    css: string,
    map: string,
    styles: Styles
  ) => CSS | Promise<CSS> | PostCSSProcessor
  sass?: SassRenderer
  sourceMap?: boolean
  verbose?: boolean
  watch?: string | string[]
  outputStyle?: string
}

type ImporterReturnType = { file: string } | { contents: string } | Error | null

type ImporterDoneCallback = (data: ImporterReturnType) => void

type CSS = string | { css: string; map: string }

interface MappedCSS {
  css: string
  map: string
}

interface Styles {
  [id: string]: string
}

interface PostCSSProcessor {
  process: (css: string, options?: any) => MappedCSS
}

interface SassRenderer {
  renderSync: (options: SassOptions) => SassResult
}

interface SassOptions {
  data: string
}

interface SassResult {
  css: Buffer
  map?: Buffer
}

export default function scss(options: CSSPluginOptions = {}): Plugin {
  const filter = createFilter(
    options.include || ['/**/*.css', '/**/*.scss', '/**/*.sass'],
    options.exclude
  )
  let dest = typeof options.output === 'string' ? options.output : null
  const insertStyleFnName = '___$insertStylesToHeader'

  const styles: Styles = {}
  const prefix = options.prefix ? options.prefix + '\n' : ''
  let includePaths = options.includePaths || ['node_modules/']
  includePaths.push(process.cwd())

  const compileToCSS = async function (scss: string) {
    // Compile SASS to CSS
    if (scss.length) {
      includePaths = includePaths.filter((v, i, a) => a.indexOf(v) === i)
      try {
        const sass = options.sass || loadSassLibrary()

        const render = sass.renderSync(
          Object.assign(
            {
              data: prefix + scss,
              outFile: dest,
              includePaths,
              importer: (
                url: string,
                prev: string,
                done: ImporterDoneCallback
              ): ImporterReturnType | void => {
                /* If a path begins with `.`, then it's a local import and this
                 * importer cannot handle it. This check covers both `.` and
                 * `..`.
                 *
                 * Additionally, if an import path begins with `url` or `http`,
                 * then it's a remote import, this importer also cannot handle
                 * that. */
                if (
                  url.startsWith('.') ||
                  url.startsWith('url') ||
                  url.startsWith('http')
                ) {
                  /* The importer returns `null` to defer processing the import
                   * back to the sass compiler. */
                  return null
                }

                /* If the requested path begins with a `~`, we remove it. This
                 * character is used by webpack-contrib's sass-loader to
                 * indicate the import is from the node_modules folder. Since
                 * this is so standard in the JS world, the importer supports
                 * it, by removing it and ignoring it. */
                const cleanUrl = url.startsWith('~')
                  ? url.replace('~', '')
                  : url

                /* Now, the importer uses `require.resolve()` to attempt
                 * to resolve the path to the requested file. In the case
                 * of a standard node_modules project, this will use Node's
                 * `require.resolve()`. In the case of a Plug 'n Play project,
                 * this will use the `require.resolve()` provided by the
                 * package manager.
                 *
                 * This statement is surrounded by a try/catch block because
                 * if Node or the package manager cannot resolve the requested
                 * file, they will throw an error, so the importer needs to
                 * defer to sass, by returning `null`.
                 *
                 * The paths property tells `require.resolve()` where to begin
                 * resolution (i.e. who is requesting the file). */
                try {
                  const resolved = require.resolve(cleanUrl, {
                    paths: [prefix + scss]
                  })

                  /* Since `require.resolve()` will throw an error if a file
                   * doesn't exist. It's safe to assume the file exists and
                   * pass it off to the sass compiler. */
                  return { file: resolved }
                } catch (e: any) {
                  /* Just because `require.resolve()` couldn't find the file
                   * doesn't mean it doesn't exist. It may still be a local
                   * import that just doesn't list a relative path, so defer
                   * processing back to sass by returning `null` */
                  return null
                }
              }
            },
            options
          )
        )

        const css = render.css.toString()
        const map = render.map ? render.map.toString() : ''

        // Possibly process CSS (e.g. by PostCSS)
        if (typeof options.processor === 'function') {
          const result = await options.processor(css, map, styles)

          // TODO: figure out how to check for
          // @ts-ignore
          const postcss: PostCSSProcessor = result

          // PostCSS support
          if (typeof postcss.process === 'function') {
            return Promise.resolve(
              postcss.process(css, {
                from: undefined,
                to: dest,
                map: map ? { prev: map, inline: false } : null
              })
            )
          }

          // @ts-ignore
          const output: string | MappedCSS = result

          return stringToCSS(output)
        }
        return { css, map }
      } catch (e) {
        if (options.failOnError) {
          throw e
        }
        console.log()
        console.log(red('Error:\n\t' + e.message))
        if (e.message.includes('Invalid CSS')) {
          console.log(green('Solution:\n\t' + 'fix your Sass code'))
          console.log('Line:   ' + e.line)
          console.log('Column: ' + e.column)
        }
        if (e.message.includes('sass') && e.message.includes('find module')) {
          console.log(green('Solution:\n\t' + 'npm install --save-dev sass'))
        }
        if (e.message.includes('node-sass') && e.message.includes('bindings')) {
          console.log(green('Solution:\n\t' + 'npm rebuild node-sass --force'))
        }
        console.log()
      }
    }
    return { css: '', map: '' }
  }

  return {
    name: 'scss',
    intro() {
      return options.insert === true
        ? insertStyleFn.replace(/insertStyleFn/, insertStyleFnName)
        : ''
    },
    async transform(code, id) {
      if (!filter(id)) {
        return
      }

      // Add the include path before doing any processing
      includePaths.push(dirname(id))

      // Rebuild all scss files if anything happens to this folder
      // TODO: check if it's possible to get a list of all dependent scss files
      //       and only watch those
      if (options.watch) {
        const files = Array.isArray(options.watch)
          ? options.watch
          : [options.watch]
        files.forEach(file => this.addWatchFile(file))
      }

      if (options.insert === true) {
        // When the 'insert' is enabled, the stylesheet will be inserted into <head/> tag.
        const { css, map } = await compileToCSS(code)
        return {
          code:
            'export default ' +
            insertStyleFnName +
            '(' +
            JSON.stringify(css) +
            ')',
          map: { mappings: '' }
        }
      } else if (options.output === false) {
        // When output is disabled, the stylesheet is exported as a string
        const { css, map } = await compileToCSS(code)
        return {
          code: 'export default ' + JSON.stringify(css),
          map: { mappings: '' }
        }
      }

      // Map of every stylesheet
      styles[id] = code

      return ''
    },
    async generateBundle(opts) {
      // No stylesheet needed
      if (options.output === false || options.insert === true) {
        return
      }

      // Combine all stylesheets
      let scss = ''
      for (const id in styles) {
        scss += styles[id] || ''
      }

      if (typeof dest !== 'string') {
        // Guess destination filename
        dest = opts.file || 'bundle.js'
        if (dest.endsWith('.js')) {
          dest = dest.slice(0, -3)
        }
        dest = dest + '.css'
      }

      const compiled = await compileToCSS(scss)

      if (typeof compiled !== 'object' || typeof compiled.css !== 'string') {
        return
      }

      // Emit styles through callback
      if (typeof options.output === 'function') {
        options.output(compiled.css, styles)
        return
      }

      // Don't create unwanted empty stylesheets
      if (!compiled.css.length) {
        return
      }

      // Ensure that dest parent folders exist (create the missing ones)
      ensureParentDirsSync(dirname(dest))

      // Emit styles to file
      writeFile(dest, compiled.css, err => {
        if (options.verbose !== false) {
          if (err) {
            console.error(red(err.toString()))
          } else if (compiled.css) {
            console.log(green(dest || '?'), getSize(compiled.css.length))
          }
        }
      })

      if (options.sourceMap && compiled.map) {
        let sourcemap = compiled.map
        if (typeof compiled.map.toString === 'function') {
          sourcemap = compiled.map.toString()
        }

        writeFile(dest + '.map', sourcemap, err => {
          if (options.verbose !== false && err) {
            console.error(red(err.toString()))
          }
        })
      }
    }
  }
}

/**
 * Create a style tag and append to head tag
 *
 * @param {String} css style
 * @return {String} css style
 */
const insertStyleFn = `function insertStyleFn(css) {
  if (!css) {
    return
  }
  if (typeof window === 'undefined') {
    return
  }

  const style = document.createElement('style');

  style.setAttribute('type', 'text/css');
  style.innerHTML = css;
  document.head.appendChild(style);
  return css
}`

function loadSassLibrary(): SassRenderer {
  try {
    return require('sass')
  } catch (e) {
    return require('node-sass')
  }
}

function stringToCSS(input: string | CSS): MappedCSS {
  if (typeof input === 'string') {
    return { css: input, map: '' }
  }
  return input
}

function red(text: string) {
  return '\x1b[1m\x1b[31m' + text + '\x1b[0m'
}

function green(text: string) {
  return '\x1b[1m\x1b[32m' + text + '\x1b[0m'
}

function getSize(bytes: number) {
  return bytes < 10000
    ? bytes.toFixed(0) + ' B'
    : bytes < 1024000
    ? (bytes / 1024).toPrecision(3) + ' kB'
    : (bytes / 1024 / 1024).toPrecision(4) + ' MB'
}

function ensureParentDirsSync(dir: string) {
  if (existsSync(dir)) {
    return
  }

  try {
    mkdirSync(dir)
  } catch (err) {
    if (err.code === 'ENOENT') {
      ensureParentDirsSync(dirname(dir))
      ensureParentDirsSync(dir)
    }
  }
}

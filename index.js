// dsh-dev-hotreload — 本地源码「保存即热重载」桥。
//
// 为什么需要它（dsh-hmr 0.2.1-rc.3 实测结论）：
// - `link:` / `file:` 安装的本地包，模块在 ESM 缓存里是
//   `<profile>/node_modules/<pkg>` 的 symlink URL，而模块监听的 dispatch 用
//   realpath 得到的真实路径做键匹配，`esmHas(url)` 恒为 false —— 所以
//   `hmr.config.root` 的“模块监听”对本地链接包永远不生效。
// - 官方真正有效的路径是「profile 重新组合（reconciliation）」：profile 的
//   cordis.patch.yml / package.json 发生变化时，dsh-hmr 会比对已加载模块的
//   文件身份（mtime + size），把发生变化的插件停掉、清缓存、重新 import。
//   README 明确说明 linked 包在下次重组合时生效。
//
// 本插件的做法：递归监视本地源码目录（默认自动发现 profile 里所有 linked
// 包的真实目录），保存后防抖一段时间，然后轻触 profile 的 cordis.patch.yml
// 里那行 tick 注释，用官方配置监视触发同一套重组合：
//   保存源码 → tick → 重组合 → 插件热替换（工具 schema 同步更新）
//   → client-hmr 把前端 bundle 更新推给页面。
//
// 零配置即可用；配置项见 README.md。
import { appendFileSync, readdirSync, readFileSync, realpathSync, statSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-dev-hotreload';
export const inject = [];

// 目录排除 + 编辑器/写盘工具的临时文件排除（它们会在一次保存里产生大量重复事件）。
const IGNORED =
  /(^|[\\/])(node_modules|\.git|\.hg|\.svn|dist|build|out|coverage|cache|\.cache|\.turbo)([\\/]|$)|\.tmpdir([\\/]|$)|~RF[0-9a-f]+\.TMP$|\.tmp$/i;
const TICK = /^# hot-reload-tick:/;
const LINK_SPEC = /^(link|file):/i;

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function canonical(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** 一个目录像不像 DSH profile：有 package.json，且声明了 dsh.profile.bundles 或带 node_modules。 */
export function looksLikeProfile(dir) {
  if (!isDirectory(dir)) return false;
  const manifest = readJson(join(dir, 'package.json'));
  if (!manifest) return false;
  const bundles = manifest.dsh?.profile?.bundles;
  return (Array.isArray(bundles) && bundles.length > 0) || isDirectory(join(dir, 'node_modules'));
}

/**
 * 定位当前 profile 目录。优先问宿主拿 profileContext.dir（最权威），
 * 再退回组合根（ctx.baseUrl）、宿主进程参数里的 profile 路径
 * （桌面端 host 命令行形如 `... <dsh.js> <profileDir> ...`），
 * 最后用 $DSH_HOME/profiles/desktop。
 */
export function resolveProfileDir(ctx) {
  const candidates = [];
  try {
    const dir = ctx?.get?.('profileContext')?.dir;
    if (typeof dir === 'string' && dir) candidates.push(dir);
  } catch {
    /* service unavailable: fall through to heuristics */
  }
  const baseUrl = ctx?.baseUrl;
  if (typeof baseUrl === 'string' && baseUrl) {
    try {
      candidates.push(fileURLToPath(new URL('./', baseUrl)));
    } catch {
      /* ignore malformed baseUrl */
    }
  }
  for (const arg of process.argv) {
    if (typeof arg === 'string' && isAbsolute(arg) && isDirectory(arg)) candidates.push(arg);
  }
  const home = process.env.DSH_HOME;
  if (home) candidates.push(join(home, 'profiles', 'desktop'));
  for (const candidate of candidates) {
    const dir = resolve(candidate);
    if (looksLikeProfile(dir)) return dir;
  }
  return undefined;
}

/**
 * 自动发现本地源码目录：profile 的 package.json 里 `link:` / `file:` 依赖指向的
 * 真实目录，加上 node_modules 顶层所有 symlink 的真实目录（pnpm link 的落点）。
 */
export function discoverLinkedDirs(profileDir) {
  const found = new Map();
  const add = (path) => {
    if (!path || !isDirectory(path)) return;
    const real = canonical(path);
    found.set(real.toLowerCase(), real);
  };

  const manifest = readJson(join(profileDir, 'package.json'));
  for (const spec of Object.values(manifest?.dependencies ?? {})) {
    if (typeof spec !== 'string') continue;
    const match = LINK_SPEC.exec(spec);
    if (!match) continue;
    let target = spec.slice(match[0].length).trim();
    if (/^file:/i.test(spec)) {
      try {
        target = fileURLToPath(spec);
      } catch {
        /* keep raw */
      }
    }
    target = target.replace(/^\/+([A-Za-z]:)/, '$1');
    add(isAbsolute(target) ? target : resolve(profileDir, target));
  }

  const modules = join(profileDir, 'node_modules');
  let entries = [];
  try {
    entries = readdirSync(modules, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const path = join(modules, entry.name);
    if (entry.isSymbolicLink()) {
      add(path);
      continue;
    }
    // scoped: @scope/pkg 也可能是 symlink
    if (entry.isDirectory() && entry.name.startsWith('@')) {
      try {
        for (const inner of readdirSync(path, { withFileTypes: true })) {
          const scoped = join(path, inner.name);
          if (inner.isSymbolicLink()) add(scoped);
        }
      } catch {
        /* ignore unreadable scope dir */
      }
    }
  }
  return [...found.values()];
}

export function apply(ctx, config) {
  const options = config ?? {};
  const debounce = Number.isFinite(options.debounce) ? options.debounce : 400;
  const autoDiscover = options.autoDiscover !== false;
  const profileDir = options.profile ?? resolveProfileDir(ctx);
  const patch = options.patch ?? (profileDir ? join(profileDir, 'cordis.patch.yml') : undefined);
  const logFile = options.log === false ? undefined : (options.log ?? join(tmpdir(), 'dsh-dev-hotreload.log'));

  const log = (message) => {
    try {
      if (logFile) appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
    } catch {
      /* logging must never break the host */
    }
  };

  if (!patch) {
    log('disabled: profile directory not found, no cordis.patch.yml to tick');
    return;
  }

  const explicit = Array.isArray(options.dirs) ? options.dirs.filter((dir) => typeof dir === 'string' && dir) : [];
  const discovered = autoDiscover && profileDir ? discoverLinkedDirs(profileDir) : [];
  const dirs = [...new Set([...discovered, ...explicit.map((dir) => canonical(resolve(dir)))])];

  if (dirs.length === 0) {
    log(`disabled: no source directory to watch (profile=${profileDir ?? 'unknown'}, patch=${patch})`);
    return;
  }

  log(`apply: profile=${profileDir ?? 'unknown'} dirs=${dirs.length} debounce=${debounce}`);

  let disposed = false;
  let pending = null;
  let busy = false;

  const tick = () => {
    if (disposed || busy) return;
    busy = true;
    try {
      const source = readFileSync(patch, 'utf8');
      const kept = source
        .split(/\r?\n/)
        .filter((line) => !TICK.test(line.trim()))
        .join('\n')
        .replace(/\n+$/, '');
      writeFileSync(patch, `${kept}\n# hot-reload-tick: ${new Date().toISOString()}\n`);
      log('ticked cordis.patch.yml');
    } catch (error) {
      log(`tick failed: ${error?.message ?? error}`);
    } finally {
      busy = false;
    }
  };

  const schedule = (reason) => {
    if (disposed) return;
    log(`change: ${reason}`);
    if (pending !== null) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      tick();
    }, debounce);
    if (pending.unref) pending.unref();
  };

  ctx.effect(() => {
    const watchers = [];
    for (const dir of dirs) {
      try {
        watchers.push(
          watch(dir, { recursive: true }, (_event, filename) => {
            const file = typeof filename === 'string' ? filename : (filename?.toString?.() ?? '');
            if (!file || IGNORED.test(file)) return;
            schedule(file);
          }),
        );
        log(`watching ${dir}`);
      } catch (error) {
        log(`watch failed ${dir}: ${error?.message ?? error}`);
      }
    }
    return () => {
      disposed = true;
      if (pending !== null) clearTimeout(pending);
      pending = null;
      for (const watcher of watchers) watcher.close();
      log('stopped watching dev directories');
    };
  });
}

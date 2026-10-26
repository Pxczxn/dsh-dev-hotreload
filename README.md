# dsh-dev-hotreload

给 DeepSeek Harness（DSH）用的**保存即热重载**桥：你在本地开发的插件/预设源码一保存，正在运行的宿主就把那个包热替换掉，不用重启。

## 它解决什么问题

DSH 自带 `@deepseek-ai/dsh-hmr`，但它对**本地链接包**的模块监听是失效的：

- `link:` / `file:` 安装的包，模块在 ESM 缓存里的键是 `<profile>/node_modules/<pkg>/...` 这个 **symlink 路径**；
- 而 HMR 的模块监听 dispatch 先用 `realpath` 得到真实路径再去比对缓存，`esmHas(url)` 恒为 `false`；
- 结果就是：改源码只 emit 一个 `hmr/change` 事件，**永远不会真正重载**（这是 dsh-hmr 0.2.1-rc.3 实测结论）。

真正有效的官方路径是 **profile 重新组合（reconciliation）**：profile 的 `cordis.patch.yml` / `package.json` 一变，dsh-hmr 就比对已加载模块的文件身份（mtime + size），把发生变化的插件停掉、清 ESM 缓存、重新 import。官方文档也明说「linked 包在下次重组合时生效」。

所以本插件的做法很轻：**监视你的本地源码目录，保存后轻触 profile 的 `cordis.patch.yml`**，触发官方那套重组合。

```
保存源码 → 防抖(400ms) → 改写 cordis.patch.yml 的 tick 注释
        → dsh-hmr 的配置监视 → profile 重组合
        → 插件热替换（工具 schema 同步更新）→ client-hmr 推送前端
```

## 安装

```bash
# 从打包好的 tgz（分发用；pnpm pack 的产物）
dsh plugin --profile <profile> add /absolute/path/to/dsh-dev-hotreload-1.0.0.tgz

# 从本地目录链接（想改源码立刻自举生效时最常用）
dsh plugin --profile <profile> add link:/absolute/path/to/dsh-dev-hotreload

# 从 GitHub
dsh plugin --profile <profile> add github:Pxczxn/dsh-dev-hotreload
```

打包自己分发：

```bash
pnpm pack --pack-destination ./dist
```

包自带 bundle 层（`dsh.bundle.patch`），安装后行 `dev-hotreload` 会自动进组合，**零配置即可工作**。

## 零配置时它怎么找到东西

| 需要的东西 | 自动发现方式 |
| --- | --- |
| profile 目录 | `profileContext.dir` → `ctx.baseUrl` → 宿主进程参数里的绝对路径 → `$DSH_HOME/profiles/desktop`，取第一个"像 profile"的目录 |
| 要监视的源码目录 | 读该 profile 的 `package.json`，取 `link:` / `file:` 依赖的真实目录；再加 `node_modules` 顶层（含 `@scope/pkg`）所有 symlink 的真实目录 |
| 要轻触的 patch 文件 | `<profile>/cordis.patch.yml` |
| 日志 | `os.tmpdir()/dsh-dev-hotreload.log` |

`node_modules`、`.git`、`dist`、`build`、`out`、`coverage`、`cache` 等目录里的写入会被忽略。

## 配置（可选）

在 profile 的 `cordis.patch.yml` 里用同 id 覆盖，**config 是整体替换**，没写的字段用默认值：

```yaml
- id: dev-hotreload
  config:
    dirs:                       # 额外监视的目录（自动发现之外）
      - 'D:\Coding\project\dsh\plugins\my-plugin'
    autoDiscover: true          # 默认 true：自动发现 link: 依赖
    profile: 'D:\...\profiles\desktop'   # 默认自动定位
    patch: 'D:\...\profiles\desktop\cordis.patch.yml'  # 默认 <profile>/cordis.patch.yml
    log: 'D:\Coding\tmp\dev-hotreload.log'             # 默认 tmpdir 下；false 关闭
    debounce: 400               # 毫秒
```

只想监视指定目录、不要自动发现：

```yaml
- id: dev-hotreload
  config:
    autoDiscover: false
    dirs:
      - 'D:\repo\my-plugin'
```

## 验证它真的在工作

1. 编辑任意 linked 包里被 `import` 到的文件（比如 `src/tools.js`）；
2. 看日志：`Get-Content "$env:TEMP\dsh-dev-hotreload.log" -Tail 20`，应出现 `change: src/...` 和 `ticked cordis.patch.yml`；
3. 宿主里立刻能用到改后的行为（比如工具输出变了），说明插件已热替换。

## 须知 / 限制

- 它依赖 `@deepseek-ai/dsh-hmr` 的**配置监视**能力。若你在 profile 里把 `hmr` 行 `disabled: true`，本插件就无效了。`config.root` 不需要为本插件设置（模块监听对 linked 包无效，`root: []` 即可）。
- 保存后有一次重组合，性能开销与"改配置"同级；`debounce` 可调。
- 重组合失败时 dsh-hmr 不会回滚到旧版本 —— 改坏代码会看到插件 `failed`，修好再保存即可恢复。
- 只对**会重新执行 `apply`** 的宿主侧代码生效；纯 client（浏览器侧）bundle 的更新由 client-hmr 负责，视插件是否声明 `dsh.client` 而定。

## 开发

```bash
node --test test/index.test.js
```

## License

MIT

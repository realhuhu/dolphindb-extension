# 架构与会话生命周期

[文档首页](README.md) · [项目首页](../README.md)

## 组成

```text
JupyterLab / Notebook 7
  ├─ 连接侧栏与 Settings Editor
  ├─ DOS 原生编辑器 / 调试面板
  │    └─ 官方 JavaScript SDK / debug 协议
  │         └─ 已认证的 Jupyter WebSocket 代理 → DolphinDB Server
  └─ Python Notebook
       └─ 内核 comm + IPython magics
            └─ 官方 Python SDK → DolphinDB Server
```

普通 DOS 会话的上游连接由 Jupyter Server 保留，浏览器 SDK 附着后解析官方协议。
DOS 调试另建 debug WebSocket，会话与源码窗口属于当前页面。Python Notebook 的 DDB 会话保存在 Python 内核。
连接列表只决定默认配置，不充当所有文档共用的执行会话。

| 范围 | 归属与固定时机 | 关闭或重启行为 |
| --- | --- | --- |
| 连接侧栏 | 当前页面的全局测试/选择连接 | 刷新后保留默认配置 ID，不自动重连侧栏测试连接 |
| 未运行 DOS 的预览 | 文件模型；可选默认或手动连接 | 最后一个视图关闭时释放；配置快照更新后重新加载 |
| DOS 普通执行 | 登录用户 + 文件路径；第一次提交代码后固定连接快照 | 页面关闭后 Server 保留；关闭会话或停止 Server 才释放 |
| DOS 调试 | 文件模型对应独立 debug 会话 | 最后一个入口编辑器关闭、页面断开或停止操作会结束调试 |
| Notebook 预览/执行 | Python 内核；第一次执行后固定 | 关闭页面不结束内核；重启/关闭内核结束 DDB 会话 |
| Notebook 自定义结果缓存 | Python 内核中的返回对象 | 预算淘汰或内核重启后需重新 `ddb_show` |
| DOS 自定义结果缓存 | 当前浏览器页面中的 SDK 对象 | 刷新后可从受限历史重新解析；超限历史无法完整恢复 |

普通 DOS 会话同时只允许一个页面附着；同页多编辑视图共享模型。多个 Notebook 显式共用一个内核时，也共享 Python 及 DDB 会话。

## 代码入口

| 模块 | 责任 |
| --- | --- |
| [frontend/index.tsx](../frontend/index.tsx) | 注册 Settings、连接、语言、数据、工作区、DOS、调试和 Notebook 插件 |
| [frontend/settings.ts](../frontend/settings.ts)、[schema/settings.json](../schema/settings.json) | 类型、默认值、设置服务与校验范围 |
| [frontend/dos/model.ts](../frontend/dos/model.ts) | DOS 会话、预览、历史、连接固定和异步请求版本 |
| [frontend/dos/runtime.ts](../frontend/dos/runtime.ts) | SDK 连接、执行及元数据适配 |
| [frontend/notebook/model.ts](../frontend/notebook/model.ts) | 自动加载、连接配置、comm、就绪屏障和元数据刷新 |
| [frontend/notebook/executor.ts](../frontend/notebook/executor.ts) | 配置先于单元格执行，然后调用 Jupyter 原生执行器 |
| [frontend/notebook/sessions.ts](../frontend/notebook/sessions.ts) | 按内核发现、去重和关闭 DDB 会话 |
| [frontend/language/editor.ts](../frontend/language/editor.ts) | 每个编辑视图的 CodeMirror 补全、悬浮、诊断与跳转绑定 |
| [frontend/language/engine.ts](../frontend/language/engine.ts) | 请求级语言宿主，隔离静态文档及所属会话元数据 |
| [frontend/session/workspace.ts](../frontend/session/workspace.ts) | 当前文档的数据库与变量侧栏、折叠和焦点处理 |
| [frontend/data/plugin.tsx](../frontend/data/plugin.tsx) | 自定义 MIME、独立浏览页、分页和交互 |
| [frontend/debugger/session.ts](../frontend/debugger/session.ts) | 调试状态机、断点同步、栈帧、模块来源及请求失效 |
| [frontend/debugger/plugin.ts](../frontend/debugger/plugin.ts) | 原生面板集成、快捷键、源码窗口和 Running 注册 |
| [src/dolphindb_extension/extension.py](../src/dolphindb_extension/extension.py) | Jupyter Server 生命周期和配置目录迁移 |
| [connections.py](../src/dolphindb_extension/connections.py)、[relay.py](../src/dolphindb_extension/relay.py) | 配置持久化、系统凭据库、短期票据和代理 |
| [dos_sessions.py](../src/dolphindb_extension/dos_sessions.py) | 会话所有者、路径、上游连接、消息边界与受限历史 |
| [magics.py](../src/dolphindb_extension/magics.py) | IPython magics、最终表达式 AST 适配、SDK 会话与 comm |
| [browser.py](../src/dolphindb_extension/browser.py)、[metadata.py](../src/dolphindb_extension/metadata.py) | Python 对象、分页、schema、变量元数据和原始值排序 |

## Jupyter 接口与权限

API 路径以 Jupyter 的 `base_url` 为前缀；连接接口使用 `dolphindb-extension:connections` 授权资源，DOS 使用 `dolphindb-extension:dos-sessions`。
执行、连接和关闭操作要求对应的 execute 权限。WebSocket 复用 Jupyter 的认证与同源检查。
连接票据为 30 秒内有效的一次性随机值；返回密码的接口使用 `Cache-Control: no-store`。

普通 DOS 的会话查找校验登录用户名，不能仅凭会话 ID 访问其他身份的会话。配置列表本身属于 Jupyter Server，因而共享服务器不等于多租户配置隔离；JupyterHub 使用每用户 Server。

内部接口分为 `connections`、`active`、`sessions`、`kernel-connection` 和 `dos-sessions`。
它们为扩展内部实现，不作为稳定的公开 HTTP SDK。Notebook 的公开用户入口是 magics 与 `ddb_show`。

## 输出与异步边界

`%ddb` / `%%ddb` 返回官方 `Session.run` 对象；赋值不包装结果。IPython 处理 magic 转换、参数和异常，AST 扩展仅识别单元格最后直接调用 DDB 的表达式。
`ddb_show` 发送 `application/vnd.dolphindb.view+json` MIME 及 `text/plain` 回退。未安装前端的客户端只能看到回退文本。

元数据和预览验证连接、执行序号、内核与变量/数据库快照；旧请求完成后不得更新新会话。
Notebook comm 和用户代码共用内核执行队列，元数据超时不计入排队等待其他单元格的时间。
服务器分页查询只接受经过校验的路径、索引和名称；不会把代码提示中的任意表达式自动交给数据库执行。

上游代码的边界和更新方法见 [开发说明](development.md)。

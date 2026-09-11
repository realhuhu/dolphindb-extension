# 连接管理与持久化

[文档首页](README.md) · [项目首页](../README.md)

1. 安装插件后重启 Jupyter。在 JupyterLab 中点击左侧海豚 D 与连接节点图标的 **DolphinDB 连接**
   按钮；在 Notebook 7 中打开一个 Notebook，通过 **View → Activate Command Palette**
   搜索并运行 `DolphinDB: 管理连接`，面板会显示在右侧。此命令也可用于 JupyterLab。
2. 点击 **新增连接**，填写连接名称、服务器 IP / 域名、端口、用户名和密码。
   可设置 1–60 秒连接超时；服务器开启 SSL 时，勾选 **使用 SSL 加密连接**。
3. 点击 **测试连接** 验证登录和节点信息，点击 **保存连接** 保存配置。
4. 在列表中点击 **连接** 或 **切换连接**。只有新连接成功后才断开旧连接，
   切换失败时原连接保持可用。当前连接区提供 **断开连接** 按钮。
5. 使用 **编辑** 更新配置，密码留空会保留已有密码，也可明确清除。
   **删除** 会移除配置、已保存的密码并断开对应连接，不修改数据库中的数据。

连接地址由 **Jupyter 服务所在机器** 访问，并通过经过 Jupyter 身份验证的 WebSocket
转发至 DolphinDB。服务器需支持 WebSocket 接口（与原 VS Code 插件相同）。
连接侧栏保留上次选择，作为 DOS 的默认连接；尚未运行的文件也可单独选择其他连接。
刷新页面后已创建的 DOS 会话会恢复，连接侧栏本身不会重新建立全局连接。

普通连接配置保存在 Jupyter 配置目录的 `dolphindb-extension/connections.json`
中，可运行 `jupyter --config-dir` 查看根目录；Windows 上通常为
`%USERPROFILE%\.jupyter\dolphindb-extension\connections.json`。
首次使用新默认目录时，会从旧 Jupyter 数据目录复制已有配置，保留原文件和已保存密码的
凭据标识；新目录已有配置时不会覆盖。显式设置的配置目录继续使用原路径。
已发布的 `0.1.0a2` 使用 Jupyter 数据目录。

密码默认只存在 Jupyter 服务内存中，重启服务后需重新输入。勾选 **记住密码** 时使用
服务器的系统凭据库（keyring）；无可用凭据库的无头 Linux 环境仍可使用会话密码。
密码不写入 JSON 配置、Notebook 或浏览器本地存储；只有建立连接时会经身份验证的接口
临时传给浏览器内的 DolphinDB SDK。编辑已有连接的地址、账号或密码会断开侧栏的测试连接，
未运行 DOS 的默认或手动选择预览会重新连接并更新数据库列表，包含仅修改密码的情况。Notebook 未运行预览的浏览页和提示缓存也会失效，已打开的实时浏览页需从原文档重新打开。已运行 DOS 的连接快照及会话保持不变；Notebook 的已固定会话也保持原连接。调试中的连接保持固定，停止调试后重新同步预览。

可通过 `--DolphinDBExtensionApp.connections_dir=/path/to/profiles` 指定配置目录。
旧参数 `DolphinDBExtensionApp.data_dir` 继续兼容；两个参数同时设置时，新参数优先。
JupyterHub 应使用每个用户独立的服务和数据目录。

## 连接位置与会话边界

| 用途 | 发起连接的机器 | 协议 | 状态存放位置 |
| --- | --- | --- | --- |
| 连接侧栏测试、DOS 预览、DOS 执行、DOS 调试 | Jupyter Server 所在机器 | WebSocket / WSS | 预览与调试属于当前页面；普通 DOS 会话由 Server 保留 |
| Notebook 的 DDB 执行与元数据 | Python 内核所在机器 | 官方 Python SDK TCP / SSL | Python 内核内存 |

远程部署时，`127.0.0.1` 指发起连接的机器自身，不一定是运行浏览器的电脑。配置列表与执行会话不同：删除配置不会把已固定的 DOS 或 Notebook 会话迁移到其他连接，释放会话请使用工具栏或 Running 面板。

[安装与部署](installation.md) · [会话生命周期](architecture.md) · [连接故障排查](troubleshooting.md)

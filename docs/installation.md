# 安装、升级与环境部署

[文档首页](README.md) · [项目首页](../README.md)

## 运行要求

| 部分 | 要求 |
| --- | --- |
| Python 包 | Python 3.10+；开发环境使用 Python 3.12 |
| 界面 | JupyterLab 4.2+ 或 Jupyter Notebook 7.2+，不支持经典 Notebook 6 |
| 服务端 | Jupyter Server 2.13+、小于 3 |
| Notebook magics | Python / IPython 内核，安装 `[notebook]` extra：DolphinDB Python SDK 3.0.6–3.x、IPython 8–9 |
| DOS / 连接侧栏 | DolphinDB Server 支持 WebSocket；启用 SSL 时使用 WSS |
| DOS 调试 | 服务端支持 DolphinDB 调试协议，见 [调试要求](debugging.md) |
| 从源码构建 | Node.js 22.18+、npm、uv；安装预构建 Python 包不需要 Node.js |

## 同一 Python 环境安装

在运行 Jupyter 的环境中执行：

```shell
python -m pip install "jupyterlab>=4.2,<5" "dolphindb-extension[notebook]==0.1.0b1"
python -m jupyterlab
```

已有 JupyterLab / Notebook 7 时只安装扩展即可。仅使用连接管理和 DOS 文件，可省略 `[notebook]`。
使用 Notebook 7 的命令为 `python -m notebook`；如果环境中还没有 Notebook，先安装 `notebook>=7.2,<8`。

安装或升级后重启 Jupyter Server、刷新浏览器；已启动的 Python 内核需要重启以使用新的后端代码。
重启前保存文件，重启会释放对应的内存会话变量。正常使用中修改设置无需重启。

## Server 与内核使用不同环境

- Jupyter Server 环境安装 `dolphindb-extension`，用于前端发现、配置 API 和 DOS 连接代理。
- Python 内核环境安装相同版本的 `dolphindb-extension[notebook]`，用于 magics、原生 Python 返回值及数据浏览。
- Notebook 工具栏通过已认证的 Jupyter API / comm 传入连接，不要求内核直接读取 Server 的配置文件。

在 Notebook 中查看 `sys.executable` 可以确认实际内核路径；不要仅凭终端中 `pip` 的位置判断安装环境。

```python
import sys
from importlib.metadata import version

print(sys.executable)
print(version("dolphindb-extension"))
```

## 检查是否加载

在 Jupyter Server 的环境中运行：

```shell
jupyter labextension list
jupyter server extension list
```

前端名称为 `dolphindb-extension`，服务端模块名为 `dolphindb_extension`；应处于 enabled / OK 状态。
JupyterLab 左侧有 **DolphinDB 连接**，右侧有数据库与变量及 DOS 调试按钮。
Notebook 7 可通过命令面板运行 `DolphinDB: 管理连接`。

前端随 wheel 和源码分发包预构建，正常安装无需执行 `jupyter lab build`，也无需 `jupyter labextension install`。
JupyterLab 扩展管理器是否显示 Beta 版本受其包索引和预发布过滤影响；搜索不到时直接用上述 pip 命令安装。

## 升级与卸载

安装后续预发布版本可使用：

```shell
python -m pip install --pre --upgrade "dolphindb-extension[notebook]"
```

若要验证当前尚未发布的修复，使用 [源码开发安装](development.md)，不要将发布版与工作区构建混用。
卸载使用 `python -m pip uninstall dolphindb-extension`，之后重启 Jupyter 与相关内核。
卸载包不自动删除连接配置、系统凭据库密码或 Jupyter 用户设置；需要清理连接时可先在侧栏删除。

## 远程部署

浏览器只需访问 Jupyter。DOS 的目标地址由 Jupyter Server 访问，Notebook 的目标地址由 Python 内核访问。
代理、防火墙或容器需要允许相应的 WebSocket / TCP 连接；启用 SSL 时证书必须被发起连接的环境信任。

JupyterHub 应给每个用户独立的 Jupyter Server 和配置目录。配置和凭据保存位置见 [连接管理](connections.md)。

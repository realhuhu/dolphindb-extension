# dolphindb-extension 文档

本目录对应当前源码。包版本为 `0.1.0b1`（Beta），版本变更见 [CHANGELOG](../CHANGELOG.md)。
功能以本项目的实现和下面的迁移清单为准，不表示已经迁移原 VS Code 插件的全部功能。

## 开始使用

1. [安装、升级与环境部署](installation.md)：区分 Jupyter Server 和 Python 内核环境。
2. [连接管理与持久化](connections.md)：可视化配置、默认连接、密码和保存位置。
3. [DOS 编辑、执行与会话](dos.md)：文件、选区、批量运行、独立会话和 Running 面板。
4. [Notebook magics 与返回值](notebooks.md)：`%ddb`、`%%ddb`、赋值、`ddb_show` 和原生输出。

## 功能与配置

| 文档 | 内容 |
| --- | --- |
| [代码提示、高亮与模块](language.md) | 补全、函数文档、定义跳转、静态符号与运行时元数据 |
| [数据浏览、结构、图表与张量](data-browser.md) | 分页、排序、变量预览、表语句生成、缓存及精度 |
| [DOS 调试](debugging.md) | 断点、单步、模块源码、变量、会话管理和快捷键 |
| [完整设置参考](settings.md) | 所有配置键、默认值、范围、生效时机和保存目录 |
| [故障排查](troubleshooting.md) | 连接、加载、补全、显示、缓存、调试和安装问题 |
| [与 VS Code 的对应关系](migration.md) | 已迁移能力、Jupyter 适配差异和未迁移功能 |

## 开发与维护

- [架构和会话生命周期](architecture.md)
- [本地开发、上游同步与测试](development.md)
- [构建产物检查与发布](release.md)
- [变更记录](../CHANGELOG.md)

## 示例

- [quickstart.dos](examples/quickstart.dos)：内存表、函数、变量和选区运行。
- [quickstart.ipynb](examples/quickstart.ipynb)：Python 返回值、自动/显式自定义显示和嵌套对象。

示例使用你在侧栏中配置的连接，只创建普通会话变量和内存表，不包含地址、密码和执行输出。
将文件下载或复制到 Jupyter 文件根目录后打开；源码位于根目录外时，Jupyter 文件浏览器无法直接访问。

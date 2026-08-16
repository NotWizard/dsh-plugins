# DSH Plugins

服务于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的**插件集合**。每个子目录是一个自包含的树外（out-of-tree）插件，带自己的源码、文档和一键安装脚本。

## 插件列表

| 插件 | 作用 | 安装 |
|---|---|---|
| [dsh-web-search-bailian](./dsh-web-search-bailian) | 让 `web_search` 走阿里云百炼内置搜索（复用 `BAILIAN_API_KEY`，无需 DeepSeek key） | `cd dsh-web-search-bailian && bash install.sh` |

## 怎么用

克隆本仓库，进入想要的插件目录，跑它自带的 `install.sh`：

```bash
git clone https://github.com/NotWizard/dsh-plugins.git
cd dsh-plugins/<插件目录>
bash install.sh
```

每个插件的具体前提、原理与回退方法见其目录下的 `README.md`。

## 约定

- **一个插件一个文件夹**，文件夹内自带 `install.sh`（自包含，base64 内嵌插件文件，跨 macOS/Linux，幂等）。
- 插件统一注册进 DSH 的某个能力 seam（如 `ctx.web`），通过 profile 的 `cordis.patch.yml` 挂载与选择，不改 DSH 源码。
- 若某个插件日后独立成库，直接把它的文件夹移出即可,互不牵连。

## 说明

- 这些是第三方插件，与 DeepSeek 官方无关。
- 安装脚本不会写入任何密钥；密钥走各机器自己的 `~/.dsh/.credentials.yaml`。

# dsh-web-search-bailian

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 `web_search` 工具走**阿里云百炼（DashScope）内置搜索**的插件。无需 DeepSeek API key，复用你已有的 `BAILIAN_API_KEY`。

## 它解决什么问题

当 Harness 的主模型接的是百炼（如 `qwen3.8-max`）时，模型每次想调 `web_search`，Harness 默认会路由到 DeepSeek 官方搜索提供方——那需要单独的 `DEEPSEEK_API_KEY`。没有它，搜索就失败，或触发各种绕路行为。

这个插件向 Harness 的 web 能力层（`ctx.web`）注册了一个新的搜索提供方 `bailian`：它在内部调用百炼 **Responses 端点**并启用其**内置 `web_search` 工具**，把服务端搜到的来源与答案映射回 Harness 的标准搜索结果。官方 `dsh-web-search-deepseek` 是同款套路，只是把"独立搜索请求"换成了百炼的内置分支。

## 快速安装（新电脑）

前提：该机器已能用 `npx @deepseek-ai/dsh web` 启动过 Harness（首次运行会初始化 `~/.dsh/profiles`），且已配好百炼接入。

```bash
git clone https://github.com/<你的用户名>/dsh-web-search-bailian.git
cd dsh-web-search-bailian
bash install-bailian-search.sh
```

脚本是幂等的，会自动完成：
1. 把插件写入 `~/.dsh/profiles/web/node_modules/@local/dsh-web-search-bailian/`
2. 建立跨 profile 可解析的软链
3. 在 `~/.dsh/profiles/web/cordis.patch.yml` 追加：注册插件 + 把 `web.config.searchProvider` 切到 `bailian`
4. 自检 `settings.yaml`（`api: openai-completions`）与 `BAILIAN_API_KEY` 是否就位

装完**重启 `dsh web`** 生效。验证：设置 → 插件 → 插件列表，应能看到 `web-search-bailian`（已挂载 / 已启用）。

## 百炼接入的两个硬性前提

这两条不属于插件本身，但缺了它插件发挥不出来：

1. **主链路必须用 Chat Completions**：`~/.dsh/settings.yaml` 里 bailian provider 设 `api: openai-completions`。
   - 原因：主对话若走 Responses 端点，DashScope 会把名为 `web_search` 的工具劫持成内置调用、不回传客户端，插件永远收不到调用。Completions 端点不劫持，工具调用能正常回到 Harness。
   - 搜索本身仍走 Responses 内置分支——那是插件内部单独发起的请求，与主链路端点无关。
2. **配置 `BAILIAN_API_KEY`**：写入 `~/.dsh/.credentials.yaml`。

## 回退 / 卸载

- 换回 DeepSeek 官方搜索：编辑 `~/.dsh/profiles/web/cordis.patch.yml`，把 `searchProvider: bailian` 改回 `deepseek-official`（需 `DEEPSEEK_API_KEY`），重启。
- 彻底移除：删掉上面 patch 里新增的两条条目，再删 `~/.dsh/profiles/web/node_modules/@local/dsh-web-search-bailian/` 与软链，重启。

## 目录结构

```
dsh-web-search-bailian/        # 插件源码（package.json + lib/index.js）
install-bailian-search.sh      # 一键安装脚本（自包含，base64 内嵌插件文件）
```

## 备注

- 插件为树外（out-of-tree）插件：会出现在"插件列表"（只读清单），但"插件配置"页没有它的专属设置卡——那张卡是官方为内置插件硬编码的。要改配置直接编辑 `cordis.patch.yml`。
- Web profile 的 HMR 处于停用状态，改配置需重启 `dsh web`。

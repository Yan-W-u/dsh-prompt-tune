# dsh-prompt-tune

一键提示词优化器，作为 [DeepSeek Harness](https://github.com/) Web 界面的插件。

在输入框里写好草稿后点「优化」，用当前会话的模型把它改写成一份更精确、可直接执行的提示词，
并写回输入框；改写后按钮变成「还原」，点一下退回原文。

```
草稿：帮我看看这个脚本
        ↓ 点「优化」
改写：审查我提供的脚本，指出问题并给出可执行的修改方案。
      1. 脚本来源：`[待补充: 脚本文件路径，或直接粘贴脚本全文]`
      ...
      按以下顺序检查：语法错误、逻辑与边界、错误处理与资源释放、安全风险、可维护性
      约束：只做审查，不修改脚本文件
```

## 特性

- **一键改写**：输入栏内一个药丸按钮，不离开输入框
- **一键还原**：改写后 8 秒内可退回原文；期间手动改动会自动退出还原态
- **同语言**：中文进中文出，英文进英文出
- **不编造**：缺失的细节写成 `[待补充: ...]` / `[missing: ...]` 占位，不猜事实
- **同路由**：默认复用当前会话模型，无需另配密钥；也可单独指定 provider/model
- **双调用方**：UI 按钮与 Agent 工具 `optimize_prompt` 共用同一份实现
- **可自检**：`GET /prompt-tune/status` 报告工具注册状态与生效配置

## 安装

需要已安装 DeepSeek Harness（`dsh`）与一个可用的模型路由。

### 方式一：插件管理器安装目录

```powershell
git clone https://github.com/Yan-W-u/dsh-prompt-tune.git
```

然后在插件管理器里以该目录安装 bundle：

```
plugin_manager  action: install_bundle  target: <克隆到的绝对路径>
```

### 方式二：从 npm 安装（发布后可用）

```powershell
plugin_manager  action: install_bundle  target: dsh-prompt-tune
```

安装后刷新页面，输入栏右下角、发送键左边出现「优化」按钮。

## 使用

1. 在输入框写草稿（粗糙也行）。
2. 点「优化」：
   - 处理中显示「优化中」并带旋转图标；
   - 完成后文案变「还原」，8 秒内点击即恢复原文；
   - 期间手动改动输入框会退出「还原」状态；
   - 空输入框点击会提示「先写点什么」，不会静默无响应。
3. 也可让 Agent 直接调用工具：

```
optimize_prompt(text: "帮我看看这个脚本", sessionId?: "<可选，用于复用该会话的路由>")
```

## 配置

```yaml
- id: prompt-tune
  name: 'dsh-prompt-tune'
  config:
    timeoutMs: 60000      # 单次改写超时，5s–300s
    maxInputChars: 20000  # 草稿长度上限，超出返回 413
    # 可选：把优化单独交给一个更强的模型
    # provider: trae
    # model: deepseek-v4.1
```

模型路由按此顺序解析：

1. 配置里的 `provider` / `model`
2. 请求带 `sessionId` 时，该会话已记录的路由
3. `agentDefaultModel.currentSelection()`
4. 第一个可用 provider 的首个模型

## 工作原理

单次模型调用，不是微调、不接第三方优化服务、不做多候选重排。核心是 Host 侧一份固定的
system prompt（保真 / 防幻觉 / 可执行化 / 控制规模四类规则），加上三个确定性后处理：

- 剥除模型可能仍包上的代码围栏
- 空输出直接报错，不写回空的输入框
- 输出与输入完全一致时提示「已经够清楚了」，不假装改写过

请求只带一条 user 消息，不带会话历史与工具上下文。

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host：`POST /prompt-tune/optimize`、`GET /prompt-tune/status`、`optimize_prompt` 工具 |
| `client.js` | Client：`conversation.input.right` 里的药丸按钮 + 改写写回 + 还原 |
| `cordis.patch.yml` | 插入 `prompt-tune` 这一行 |
| `locale/*.json` | 插件管理器里的标题与描述 |
| `icon.svg` | 插件图标 |

## 自检

```powershell
curl.exe -s http://127.0.0.1:<dsh 端口>/prompt-tune/status
# {"ok":true,"tool":"registered","error":"","config":{...}}

curl.exe -s -X POST http://127.0.0.1:<dsh 端口>/prompt-tune/optimize `
  -H "content-type: application/json" -d "{\"text\":\"帮我整理一下这个文件夹\"}"
```

`tool` 为 `registered` 表示 Agent 侧工具已挂上；`failed` 时 `error` 写明原因。

## 卸载

```
plugin_manager  action: remove_bundle  target: dsh-prompt-tune
```

## 许可

MIT，见 [LICENSE](LICENSE)。

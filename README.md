# dsh-workbuddy-connect 11128「请求被拦截」加固补丁

给 [`dsh-workbuddy-connect`](https://github.com/corrinehu/dsh-workbuddy-connect)（把 WorkBuddy 桌面版模型接进 DeepSeek Harness 的插件）打的运行时补丁。

现象：用 workbuddy 模型跑一轮就失败

```
400 workbuddy upstream client (http 400): 请求被拦截，请重新发送
INVALID_REQUEST
```

上游原文：

```json
{"code":11128,
 "msg":"Illegal API invocation from an unapproved channel",
 "displayMsg":{"zh":"请求被拦截，请重新发送"},
 "displayTips":{"zh":"这次调用没通过渠道校验，可能不是官方客户端发出的。请用官方版本重新发送。"}}
```

`11128` 不是一条规则，实测至少有两类完全不同的触发路径，本补丁两条都堵。

---

## 根因 1：`role: "developer"`

pi-ai 在 `model.reasoning && compat.supportsDeveloperRole` 时把系统提示写成 `role: "developer"`（`@earendil-works/pi-ai/dist/api/openai-completions.js:896`、`:919`，且**任何位置的 system 消息**都会用它）。WorkBuddy CN 网关对该角色一律 400/11128。

对照实验（真实凭证，其余不变）：

| messages | 结果 |
|---|---|
| `[{role:"system"}, …]` | 200 |
| `[{role:"developer"}, …]` | **400 / 11128** |
| `developer` 出现在会话中途 | **400 / 11128** |

## 根因 2：system 角色文本超过约 45,150 字符

网关对 **system 角色文本**做渠道/内容校验，越线即 400/11128。用真实失败 body（246 条消息、72 个工具、51,136 字符系统提示）二分定位：

| 变量 | 结果 |
|---|---|
| 完整 body（system 51,136 字符） | 400 / 11128 |
| system 截断到 45,143 字符 | **200** |
| system 截断到 45,193 字符 | 400 / 11128 |
| system 换成 51,136 字符的等长无意义填充 | 200 |
| system 51,136 字符拆成 `system(30k) + user(26k)` | **200** |
| 两条 system 消息 25k + 26k | 400（按 system 总量计）|
| 去掉 tools / 只留最后 20 条 / 剥掉 `reasoning_content` / 换 6 套 UA 与身份头 | 全 400（与这些无关）|

阈值对"内容是否有害"不敏感（jailbreak 风格文本、等长填充都不触发），只对 **system 角色的累计文本量**敏感；另一条独立的短请求（system 30k + 其余转 user）实测 200。

本机 Harness 的系统提示（`project_instructions` + `AGENTS.md` + skills 目录）约 **51k 字符**，稳定越线 6k，所以是「每轮必挂」而非偶发。

---

## 补丁做了什么

改动落在编译产物 `lib/host-heartbeat-*.js` 与 `lib/index.js`（npm 包不含 `src/`，见下方「局限」）：

1. **角色净化**（`__wbSanitizeBody` / `__wbSanitizeShimBody`）
   shim 入口与 `chatStream` 出口各跑一次：`developer` → `system`，`system/user/assistant/tool/function` 之外的角色直接丢弃，强置 `stream: true`。任何调用路径都绕不过。

2. **超长 system 拆分**（`__wbSplitOversizedSystem`）
   system 文本 > `SYSTEM_PROMPT_CHAR_LIMIT`(30000) 时，保留 30k 在 `system`，其余**原文一字不落**作为紧随其后的 `user` 消息，并标注「以上系统指令的后续部分，效力等同系统指令」。
   system 总量 > `SYSTEM_PROMPT_PROACTIVE_CHARS`(42000) 时**发送前就拆**，不再先吃一个必然的 400。

3. **失败自动重试**
   仍命中 11128 时依次尝试「角色归一」→「系统提示拆分」，并把结果写日志。

4. **自诊断**
   失败时落盘原始 body 到 `~/.dsh/logs/workbuddy-capture-last.json`，并跑两组变体重放（`BISECT` 6 组 body 变体、`BISECT-H` 6 组客户端身份头），结果写 `~/.dsh/logs/workbuddy-debug.log`。哪一行是 `200 OK`，病根就在那一轴。

5. **错误可读化**
   最终失败信息会带上 system 字符数、已尝试的写法与实测阈值，而不是只给一句「请求被拦截」。

## 验证

```bash
# 复现两个根因 + 验证拆分修法（用你自己的凭证，小样本 max_tokens=16）
node scripts/verify.mjs ~/.dsh/workbuddy-vault/cn/<accountId>.json \
                       ~/.dsh/logs/workbuddy-capture-last.json
```

另有一次端到端实测：把捕获到的**原始失败 body 原文**（665 KB / 246 条消息 / 51,136 字符系统提示 / 72 个工具）灌进打补丁后的 `chatStream`——

```
补丁前：400 / code 11128
补丁后：200，SSE 正常出流，首包 2.75 s（发前拆分，一次成功，无重试）
```

本机接入后连续两轮 workbuddy 请求日志：

```
PROACTIVE-SPLIT systemChars=51136 -> 30000
PROACTIVE-SPLIT systemChars=51136 -> 30000
（无 FAIL / BISECT / 11128）
```

## 安装

```bash
./reapply.sh                       # 默认 ~/.dsh/profiles/web/node_modules/dsh-workbuddy-connect/lib
./reapply.sh /path/to/lib          # 或显式指定
# 然后重启 dsh
```

脚本会先备份到 `backups/<时间戳>/`，`node --check` 不过自动回滚。

## 局限

- 补丁改的是 **npm 包的编译产物**（`lib/host-heartbeat-*.js`、`lib/index.js`），不是上游 TypeScript 源码。插件升级会覆盖 `lib/`，升级后需重跑 `reapply.sh`。
- bundle 文件名带 hash（`host-heartbeat-XXXX.js`），但导出符号名（`$`、`F`、`O`、`P` 等）是打包器固定产物，`patched/lib` 内保留的是 0.7.6（对应内核 `@deepseek-ai/dsh 0.2.0-rc.2` / `pi-ai 0.87.1`）的产物。跨内核版本升级后需要重新生成补丁，不能直接覆盖。
- 上游若要正式修，建议把这两处逻辑写进 `src/upstream.ts` 的 `prepareCnChatBody` / `chatStream`，本仓库保留实测数据作为依据。

## 文件

```
reapply.sh                 套用补丁（备份 + 语法自检 + 自动回滚）
patched/lib/               打完补丁的两个构建产物（0.7.6）
scripts/verify.mjs         根因复现与修法验证
```

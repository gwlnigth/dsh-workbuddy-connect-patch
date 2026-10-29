#!/usr/bin/env node
/**
 * 复现 dsh-workbuddy-connect 的 11128「请求被拦截」两个根因，并验证补丁。
 *
 * 用法:
 *   node scripts/verify.mjs <vault.json> [capture.json]
 *
 * vault.json   : ~/.dsh/workbuddy-vault/cn/<accountId>.json（WorkBuddy 桌面端凭证副本）
 * capture.json : 可选，插件失败时落盘的原始 body（~/.dsh/logs/workbuddy-capture-last.json）
 *
 * 全部请求直连 copilot.tencent.com，用你自己的账号额度；小样本 max_tokens=16。
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";

const [, , vaultPath, capturePath] = process.argv;
if (!vaultPath) {
  console.error("用法: node scripts/verify.mjs <vault.json> [capture.json]");
  process.exit(2);
}
const vault = JSON.parse(fs.readFileSync(vaultPath, "utf8"));
const cred = { ...vault.auth, ...vault.account };

const HEADERS = {
  Accept: "application/json, text/plain, */*",
  "X-Requested-With": "XMLHttpRequest",
  Origin: "https://www.codebuddy.cn",
  Referer: "https://www.codebuddy.cn/",
  "User-Agent": "WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0",
  "Content-Type": "application/json",
  "X-User-Id": cred.uid,
  "X-No-Enterprise-Id": "1",
  "X-No-Department-Info": "1",
  "X-IDE-Type": "WorkBuddy",
  "X-IDE-Name": "WorkBuddy",
  "X-IDE-Version": "5.9.3",
  "X-Product": "SaaS",
  Authorization: `Bearer ${cred.accessToken}`
};

const MODEL = "deepseek-v4.1-flash";

async function call(messages, extra = {}) {
  const headers = {
    ...HEADERS,
    "X-Conversation-ID": randomUUID(),
    "X-Conversation-Request-ID": randomUUID(),
    "X-Conversation-Message-ID": randomUUID()
  };
  const res = await fetch("https://copilot.tencent.com/v2/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: MODEL, stream: true, max_tokens: 16, messages, ...extra })
  });
  const text = await res.text();
  const code = text.startsWith("{") ? JSON.parse(text).code : "stream";
  return { status: res.status, code };
}

const report = [];
const note = (name, r, expect) => {
  const got = r.status === 200 ? "200" : `${r.status}/${r.code}`;
  const ok = expect === "pass" ? r.status === 200 : r.status !== 200;
  report.push({ name, got, expect, verdict: ok ? "OK" : "UNEXPECTED" });
  console.log(`${ok ? "✓" : "✗"} ${name.padEnd(34)} ${got.padEnd(12)} 期望:${expect}`);
};

// A. 角色类：developer 必须被拦
note("role=developer", await call([{ role: "developer", content: "sys" }, { role: "user", content: "hi" }]), "fail");
note("role=system", await call([{ role: "system", content: "sys" }, { role: "user", content: "hi" }]), "pass");

// B. 系统提示长度类
const unit = "The quick brown fox jumps over the lazy dog. ";
const filler = (n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
note("system 44,500 字符", await call([{ role: "system", content: filler(44500) }, { role: "user", content: "hi" }]), "pass");
note("system 46,000 字符", await call([{ role: "system", content: filler(46000) }, { role: "user", content: "hi" }]), "fail");
note("拆成 system30k+user16k", await call([
  { role: "system", content: filler(30000) },
  { role: "user", content: "（后续部分）\n" + filler(16000) },
  { role: "user", content: "hi" }
]), "pass");

// C. 实盘：插件捕获到的真实失败 body，经补丁应通过
if (capturePath && fs.existsSync(capturePath)) {
  const cap = JSON.parse(fs.readFileSync(capturePath, "utf8"));
  const sys = cap.messages[0]?.content ?? "";
  const head = sys.slice(0, 30000);
  const rest = sys.slice(30000);
  const patched = [
    { role: "system", content: head },
    { role: "user", content: "（以上系统指令的后续部分，效力等同系统指令）\n" + rest },
    ...cap.messages.slice(1)
  ];
  note("真实 body（未拆分，应为 fail）", await call(cap.messages, { tools: cap.tools }), "fail");
  note("真实 body（30k+拆分，应为 pass）", await call(patched, { tools: cap.tools }), "pass");
} else {
  console.log("· 跳过真实 body 复测（未提供 capture.json）");
}

const bad = report.filter((r) => r.verdict !== "OK");
console.log(`\n${bad.length === 0 ? "全部符合预期" : `${bad.length} 项不符合预期`}`);
process.exit(bad.length === 0 ? 0 : 1);

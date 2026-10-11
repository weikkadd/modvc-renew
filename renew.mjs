#!/usr/bin/env node
// ModVC 免费套餐自动续期 — 纯 HTTP 实现，无需浏览器
// 流程: Firebase refresh token -> id_token (1h) -> GET /tier 判断剩余时间 -> POST /renew-free
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.MODVC_CONFIG || join(__dirname, 'config.json');
const LOG_PATH = join(__dirname, 'renew.log');

// 这两个 key 都来自 panel.modvc.org 前端公开代码（HAR 可见），非私密凭据
const FIREBASE_API_KEY = 'AIzaSyBONYuQnDHiL-4-sN_dwRx--ozyJhZj4qY';
const API_BASE = 'https://api.modvc.org';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:157.0) Gecko/20100101 Firefox/157.0';

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_PATH, line + '\n'); } catch { /* 日志写失败不影响主流程 */ }
}

function fail(msg, code) {
  log(msg);
  process.exitCode = code;
}

function loadConfig() {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    fail(`FATAL 无法读取配置 ${CONFIG_PATH}: ${e.message}`, 1);
    return null;
  }
  cfg.renewWithinHours ??= 2;
  cfg.notifyTzOffset ??= 8;      // 通知显示时区，默认北京时间 UTC+8
  cfg.notifyEveryRun ??= false; // true=每轮都推；false=仅状态变化时推（避免每小时刷屏） // 剩余不足该小时数时触发续期（留出停机余量）
  return cfg;
}

function saveConfig(cfg) {
  try { writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n'); } catch { /* 忽略 */ }
}

class AuthError extends Error {}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 保留原始 text */ }
  return { status: res.status, data, text };
}

// Firebase ID token 只有 1 小时寿命，用长期 refresh token 换新；
// Firebase 可能轮换 refresh token，轮换时写回配置
async function mintIdToken(cfg) {
  const { status, data } = await fetchJson(
    `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cfg.refreshToken }),
    }
  );
  if (status !== 200) {
    const errCode = data?.error?.message || data?.error || `HTTP ${status}`;
    if (String(errCode).includes('INVALID_REFRESH_TOKEN')) {
      throw new AuthError('refresh token 已失效（可能已在别处登出）。请按 README 重新从浏览器提取并更新 config.json');
    }
    throw new Error(`Firebase 刷新 token 失败: ${errCode}`);
  }
  if (data.refresh_token && data.refresh_token !== cfg.refreshToken) {
    cfg.refreshToken = data.refresh_token;
    saveConfig(cfg);
    log('refresh token 已轮换，config.json 已更新');
  }
  return data.id_token;
}

async function api(method, path, token, body) {
  return fetchJson(API_BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': UA,
      Origin: 'https://panel.modvc.org',
      Referer: 'https://panel.modvc.org/',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ============ 通知格式化（取值全部来自探测结果，不硬编码） ============
const STATE_PATH = join(__dirname, '.notify_state');

const STATUS_META = {
  success: { icon: '\u2705', text: '续期成功' },
  noop:    { icon: '\u23ed\ufe0f', text: '本轮无需续期' },
  auth:    { icon: '\ud83d\udd11', text: '认证失效，需重新提取 token' },
  failed:  { icon: '\u274c', text: '续期失败' },
};

function tzInfo(cfg) {
  const off = Number.isFinite(cfg.notifyTzOffset) ? cfg.notifyTzOffset : 8;
  return `UTC${off >= 0 ? '+' : '-'}${Math.abs(off)}`;
}

// 按配置时区格式化；不依赖 ICU，容器 locale 是 latin-1 也不会乱码
function fmtClock(d, tz, withSec) {
  const t = new Date(new Date(d).getTime() + (tz.utcOffset * 3600e3));
  const p = (n) => String(n).padStart(2, '0');
  const base = `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
  return withSec ? `${base}:${p(t.getUTCSeconds())}` : base;
}

function fmtDur(hours) {
  if (!Number.isFinite(hours)) return '未知';
  const total = Math.round(hours * 60);
  if (total <= 0) return '已到期';
  const h = Math.floor(total / 60), m = total % 60;
  return h > 0 ? `${h}小时${m}分` : `${m}分`;
}

function fmtFeatures(f) {
  if (!f) return null;
  const base = [f.ram, f.cpu, f.uptime ? String(f.uptime).replace('/', '-') : null].filter(Boolean);
  const plus = [['autoRestart', '自动重启'], ['healthCheck', '健康检查'], ['priority', '优先'],
               ['customDomain', '自定义域名']].filter(([k]) => f[k]).map(([, v]) => v);
  if (plus.length) base.push('+' + plus.join('/'));
  return base.length ? base.join(' / ') : null;
}

function buildNotice(cfg, status, info = {}) {
  const meta = STATUS_META[status] || STATUS_META.failed;
  const tz = { utcOffset: Number.isFinite(cfg.notifyTzOffset) ? cfg.notifyTzOffset : 8 };
  const tzLabel = tzInfo(cfg);
  const now = info.now || new Date();
  // 续期窗口取自 config（与站点放行规则一致），不写死天数
  const winH = Number.isFinite(cfg.renewWithinHours) ? cfg.renewWithinHours : 24;
  const L = ['\ud83c\udde7\ud83c\udde9 ModVC 续期通知', ''];
  L.push(`\ud83d\udcca 状态: ${meta.icon} ${meta.text}`);
  if (info.tier) L.push(`\ud83d\udce6 套餐: ${info.tier}`);
  const feat = fmtFeatures(info.features);
  if (feat) L.push(`\ud83e\udde0 规格: ${feat}`);
  if (info.expiresAt && !Number.isNaN(new Date(info.expiresAt))) {
    const exp = new Date(info.expiresAt);
    L.push(`\ud83d\udcc5 到期时间: ${fmtClock(exp, tz, false)} (${tzLabel})`);
    L.push(`\u23f3 剩余: ${fmtDur((exp.getTime() - now.getTime()) / 3600e3)}`);
    if (info.canRenewAt && !Number.isNaN(new Date(info.canRenewAt))) {
      // 服务端下发的可续期时刻优先于本地推算
      L.push(`\u23f3 下次可续期: ${fmtClock(info.canRenewAt, tz, false)} (${tzLabel})`);
    } else {
      const d = (exp.getTime() - winH * 3600e3 - now.getTime()) / 3600e3;
      L.push(`\u23f3 下次可续期: ${d <= 0 ? '已进入窗口' : fmtDur(d) + '后'}`);
    }
  }
  L.push(`\ud83d\udd52 执行时间: ${fmtClock(now, tz, true)} (${tzLabel})`);
  if (info.extra) L.push(info.extra);
  L.push(`\ud83d\udccc 站点限制到期前 ${winH} 小时开放续期，下次自动处理`);
  return L.join('\n');
}

function readNoticeState() {
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}

async function maybeNotify(cfg, status, info) {
  if (status === 'noop' && !cfg.notifyEveryRun) {
    if (readNoticeState().last === 'noop') return; // 状态没变化，不打扰
  }
  try { writeFileSync(STATE_PATH, JSON.stringify({ last: status, at: new Date().toISOString() })); } catch { /* 忽略 */ }
  const text = buildNotice(cfg, status, info);
  log('--- 通知内容 ---\n' + text);
  return notify(cfg, text);
}

async function notify(cfg, text) {
  // Telegram 原生支持：sendMessage 必须带 chat_id，与 notifyWebhook 的 {"text":...} 格式不兼容
  if (cfg.tgBotToken && cfg.tgChatId) {
    try {
      const r = await fetchJson(`https://api.telegram.org/bot${cfg.tgBotToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.tgChatId, text }),
      });
      if (r.status === 200) log('TG 通知已发送');
      else log(`TG 通知失败 HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    } catch (e) {
      log(`TG 通知发送失败: ${e.message}`);
    }
    return;
  }
  if (!cfg.notifyWebhook) return;
  try {
    // 必须检查状态码：TG/Bark 等失败时返回 4xx/5xx，不检查会被误报成"已发送"
    const r = await fetchJson(cfg.notifyWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (r.status >= 200 && r.status < 300) log('通知已发送');
    else log(`通知失败 HTTP ${r.status}: ${r.text.slice(0, 200)}`);
  } catch (e) {
    log(`通知发送失败: ${e.message}`);
  }
}

async function main() {
  const cfg = loadConfig();
  if (!cfg) return;

  let token;
  if (cfg.refreshToken) {
    token = await mintIdToken(cfg);
  } else if (cfg.idToken) {
    log('警告: 当前使用 HAR 里的临时 idToken（1 小时后过期）。请在 panel.modvc.org 提取 refreshToken 填入 config.json');
    token = cfg.idToken;
  } else {
    fail('FATAL config.json 里没有 refreshToken。请按 README 从浏览器提取后填入', 1);
    return;
  }

  // 1. 查询当前套餐状态
  let tier;
  try {
    tier = await api('GET', '/tier', token);
  } catch (e) {
    fail(`ERROR 查询 /tier 网络失败: ${e.message}`, 2);
    return;
  }
  if (tier.status === 401) {
    fail('ERROR 认证被拒绝 (401)。idToken 可能已过期（临时 token 模式）或账号凭据失效', 1);
    return;
  }
  if (tier.status !== 200) {
    fail(`ERROR 查询 /tier 失败 HTTP ${tier.status}: ${tier.text.slice(0, 200)}`, 2);
    return;
  }

  const expiresAt = new Date(tier.data.expiresAt);
  const remainingH = (expiresAt.getTime() - Date.now()) / 3600e3;
  log(`当前套餐 ${tier.data.tier}，到期 ${expiresAt.toISOString()}（剩余 ${remainingH.toFixed(1)} 小时）`);

  // 2. 未到续期窗口则直接退出
  if (remainingH > cfg.renewWithinHours) {
    log(`剩余时间充足（阈值 ${cfg.renewWithinHours}h），本次不续期`);
    await maybeNotify(cfg, 'noop', {
      tier: tier.data.tier, expiresAt: tier.data.expiresAt, features: tier.data.features,
    });
    return;
  }

  // 3. 续期
  let res;
  try {
    res = await api('POST', '/renew-free', token, { adToken: null });
  } catch (e) {
    fail(`ERROR 续期请求网络失败: ${e.message}`, 2);
    return;
  }

  if (res.status === 200) {
    log(`SUCCESS 续期成功: ${res.data.message || res.text}`);
    let after;
    try {
      after = await api('GET', '/tier', token);
      if (after.status === 200) log(`新到期时间: ${after.data.expiresAt}`);
    } catch { /* 查询新到期时间失败不影响结果 */ }
    await maybeNotify(cfg, 'success', {
    tier: after?.data?.tier || tier.data.tier,
    expiresAt: after?.data?.expiresAt || tier.data.expiresAt,
    features: after?.data?.features || tier.data.features,
    extra: res.data?.message ? `\ud83d\udce4 \u670d\u52a1\u7aef\u56de\u590d: ${res.data.message}` : null,
  });
    return;
  }
  if (res.status === 429) {
    // 服务端判定未到资格（剩余 >24h），属正常情况
    log(`未到续期资格: ${res.data?.message || res.text} (canRenewAt=${res.data?.canRenewAt || '未知'})`);
    return;
  }
  if (res.status === 401) {
    fail(`ERROR 认证失败 (401): ${res.text.slice(0, 200)}`, 1);
    await maybeNotify(cfg, 'auth', {
    tier: tier.data.tier, expiresAt: tier.data.expiresAt, features: tier.data.features,
    extra: '\ud83d\udee0\ufe0f \u8bf7\u5230 panel.modvc.org \u91cd\u65b0\u6293\u53d6 refreshToken \u586b\u5165 config.json',
  });
    return;
  }
  fail(`ERROR 续期失败 HTTP ${res.status}: ${res.text.slice(0, 300)}`, 2);
  await maybeNotify(cfg, 'failed', {
    tier: tier.data.tier, expiresAt: tier.data.expiresAt, features: tier.data.features,
    extra: `\ud83d\udee0\ufe0f \u4e0b\u4e00\u5c0f\u65f6\u81ea\u52a8\u91cd\u8bd5\uff08HTTP ${res.status}\uff09`,
  });
}

main().catch(e => {
  if (e instanceof AuthError) { fail(`FATAL ${e.message}`, 1); return; }
  fail(`FATAL 未预期错误: ${e.stack || e}`, 2);
});

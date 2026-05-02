// send-slow-mover-report.js
// 每月1日執行，寄送滯銷品月報

const fs   = require('fs');
const path = require('path');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const TO_EMAIL  = 'jennifer.feebit@gmail.com';
const DATA_FILE = path.join(__dirname, '..', 'data', 'inventory-snapshots.json');

const MILD_P = 2, MODERATE_P = 4, SEVERE_P = 8, CHRONIC_P = 24;

async function main() {
  if (!RESEND_API_KEY) { console.error('❌ RESEND_API_KEY 未設定'); process.exit(1); }

  const db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const snaps = (db.snapshots || []).sort((a, b) => a.date.localeCompare(b.date));

  if (snaps.length < 2) {
    console.log(`⚠️ 快照數不足（${snaps.length} 筆），需 ≥2 筆才能分析，跳過月報`);
    return;
  }

  const slowMovers = analyze(snaps);
  const html = buildEmail(slowMovers, db);

  const today = new Date().toISOString().split('T')[0];
  const [year, month] = today.split('-');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'onboarding@resend.dev',
      to:   [TO_EMAIL],
      subject: `[飛比特] ${parseInt(year)}年${parseInt(month)}月 滯銷品月報`,
      html
    })
  });

  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  console.log(`✅ 滯銷品月報已寄送至 ${TO_EMAIL}`);
}

// ── 分析（與前端邏輯一致）──────────────────────────────────────────
function analyze(snaps) {
  const history = {};
  for (let i = 1; i < snaps.length; i++) {
    const prev = snaps[i - 1], curr = snaps[i];
    const codes = new Set([...Object.keys(prev.products), ...Object.keys(curr.products)]);
    for (const code of codes) {
      const pQty = prev.products[code]?.qty ?? 0;
      const cQty = curr.products[code]?.qty ?? 0;
      const diff = cQty - pQty;
      if (!history[code]) history[code] = [];
      history[code].push({ date: curr.date, qty: cQty, sales: diff < 0 ? -diff : 0, restocked: diff > 0 });
    }
  }

  const totalDays = (new Date(snaps.at(-1).date) - new Date(snaps[0].date)) / 86400000;
  const avgPeriodDays = totalDays / (snaps.length - 1);
  const latest = snaps.at(-1);
  const result = { chronic: [], severe: [], moderate: [], mild: [] };

  for (const [code, info] of Object.entries(latest.products)) {
    if (info.qty <= 0) continue;
    const hist = history[code] || [];

    let zeroPeriods = 0;
    for (let i = hist.length - 1; i >= 0; i--) {
      if (hist[i].restocked) break;
      if (hist[i].sales === 0) zeroPeriods++;
      else break;
    }
    if (zeroPeriods < MILD_P) continue;

    const staleMonths = (zeroPeriods * avgPeriodDays / 30).toFixed(1);
    const item = { code, name: info.name, qty: info.qty, zeroPeriods, staleMonths };

    if      (zeroPeriods >= CHRONIC_P)   result.chronic.push(item);
    else if (zeroPeriods >= SEVERE_P)    result.severe.push(item);
    else if (zeroPeriods >= MODERATE_P)  result.moderate.push(item);
    else                                  result.mild.push(item);
  }

  for (const g of Object.values(result)) g.sort((a, b) => b.zeroPeriods - a.zeroPeriods);
  return result;
}

// ── 組 HTML Email ─────────────────────────────────────────────────
function buildEmail(sm, db) {
  const today = new Date().toISOString().split('T')[0];
  const [year, month] = today.split('-');
  const total = Object.values(sm).reduce((s, g) => s + g.length, 0);

  const thS = 'background:#f8fafc;padding:9px 12px;text-align:left;font-weight:600;border-bottom:2px solid #e2e8f0;white-space:nowrap;font-size:12px;';
  const tdS = 'padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;';
  const tdR = tdS + 'text-align:right;';

  const sevConfig = [
    { key: 'chronic',  label: '常態滯銷（≥1年）',   color: '#7c3aed', bg: '#f5f3ff' },
    { key: 'severe',   label: '嚴重滯銷（≥4個月）', color: '#dc2626', bg: '#fff5f5' },
    { key: 'moderate', label: '中度滯銷（≥2個月）', color: '#d97706', bg: '#fffbeb' },
    { key: 'mild',     label: '輕微滯銷（≥1個月）', color: '#854d0e', bg: '#fefce8' },
  ];

  let sections = '';
  for (const { key, label, color, bg } of sevConfig) {
    const items = sm[key];
    if (!items.length) continue;
    const rows = items.map(it => `<tr>
      <td style="${tdS}">${esc(it.name)}</td>
      <td style="${tdS}color:#94a3b8;font-size:12px;">${esc(it.code)}</td>
      <td style="${tdR}">${it.qty.toLocaleString()}</td>
      <td style="${tdR}font-weight:600;">${it.staleMonths} 個月</td>
      <td style="${tdR}color:#94a3b8;">${it.zeroPeriods} 期</td>
    </tr>`).join('');

    sections += `
    <div style="margin-bottom:24px;">
      <div style="background:${bg};border-left:4px solid ${color};border-radius:6px;padding:10px 16px;margin-bottom:10px;color:${color};font-weight:700;font-size:14px;">
        ${label}（${items.length} 項）
      </div>
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr>
          <th style="${thS}">商品名稱</th><th style="${thS}">代號</th>
          <th style="${thS}text-align:right;">現有庫存</th>
          <th style="${thS}text-align:right;">滯銷時間</th>
          <th style="${thS}text-align:right;">期數</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  const summaryRow = [
    { l: '常態滯銷', sub: '≥1年',   c: '#7c3aed', n: sm.chronic.length },
    { l: '嚴重滯銷', sub: '≥4個月', c: '#dc2626', n: sm.severe.length },
    { l: '中度滯銷', sub: '≥2個月', c: '#d97706', n: sm.moderate.length },
    { l: '輕微滯銷', sub: '≥1個月', c: '#854d0e', n: sm.mild.length },
  ].map(s => `<td style="padding:14px;text-align:center;">
    <div style="font-size:28px;font-weight:700;color:${s.c};">${s.n}</div>
    <div style="font-size:11px;color:#64748b;margin-top:3px;">${s.l}</div>
    <div style="font-size:10px;color:#94a3b8;">${s.sub}</div>
  </td>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;margin:0;padding:20px;">
<div style="max-width:680px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1);">
  <div style="background:linear-gradient(135deg,#1e3a5f,#2563eb);padding:24px 28px;color:white;">
    <div style="font-size:11px;opacity:.7;margin-bottom:4px;">飛比特 · 庫存管理</div>
    <div style="font-size:22px;font-weight:700;">滯銷品月報</div>
    <div style="font-size:13px;opacity:.8;margin-top:4px;">${parseInt(year)}年${parseInt(month)}月 ｜ 報告日：${today} ｜ 共 ${db.snapshotCount} 期快照（${db.snapshots[0].date} ～ ${db.snapshots.at(-1).date}）</div>
  </div>
  <div style="padding:20px 28px;border-bottom:1px solid #f1f5f9;">
    <table style="width:100%;border-collapse:collapse;">${summaryRow ? `<tr>${summaryRow}</tr>` : ''}</table>
    ${total === 0 ? '<p style="text-align:center;color:#16a34a;font-weight:600;margin:12px 0 0;">本月無滯銷商品，庫存銷售狀況良好！🎉</p>' : ''}
  </div>
  <div style="padding:20px 28px;">
    ${total > 0 ? sections : '<p style="color:#64748b;text-align:center;padding:20px;">本月無滯銷商品。</p>'}
  </div>
  <div style="background:#f8fafc;padding:14px 28px;font-size:11px;color:#94a3b8;border-top:1px solid #f1f5f9;">
    飛比特庫存管理系統自動生成 ·
    <a href="https://jennifer-shao-ai.github.io/feebit/slow-mover-alert.html" style="color:#2563eb;">查看完整儀表板</a>
  </div>
</div>
</body></html>`;
}

function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

main().catch(e => { console.error('❌', e.message); process.exit(1); });

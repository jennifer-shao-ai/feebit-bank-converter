// send-reorder-report.js
// 每月1日、15日執行，寄送庫存訂貨建議

const fs   = require('fs');
const path = require('path');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const TO_EMAIL  = 'jennifer.feebit@gmail.com';
const DATA_FILE = path.join(__dirname, '..', 'data', 'inventory-snapshots.json');

async function main() {
  if (!RESEND_API_KEY) { console.error('❌ RESEND_API_KEY 未設定'); process.exit(1); }

  const db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const snaps = (db.snapshots || []).sort((a, b) => a.date.localeCompare(b.date));

  if (snaps.length < 2) {
    console.log(`⚠️ 快照數不足（${snaps.length} 筆），跳過訂貨建議`);
    return;
  }

  const result = analyze(snaps, db.receipts || {});
  const html = buildEmail(result, db);

  const today = new Date().toISOString().split('T')[0];
  const [year, month, day] = today.split('-');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'onboarding@resend.dev',
      to:   [TO_EMAIL],
      subject: `[飛比特] ${parseInt(month)}月${parseInt(day)}日 庫存訂貨建議`,
      html
    })
  });

  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  console.log(`✅ 庫存訂貨建議已寄送至 ${TO_EMAIL}`);
}

// ── 輔助：取某商品在日期區間內的已結案進貨量 ──────────────────────
function receivedInPeriod(receipts, code, afterDate, throughDate) {
  return (receipts?.[code] || [])
    .filter(r => r.date > afterDate && r.date <= throughDate)
    .reduce((s, r) => s + r.qty, 0);
}

// ── 分析核心 ─────────────────────────────────────────────────────
function analyze(snaps, receipts = {}) {
  const totalDays = (new Date(snaps.at(-1).date) - new Date(snaps[0].date)) / 86400000;

  // 累計每個商品的實際銷量（期初 + 進貨 - 期末）
  const totalSales = {};
  for (let i = 1; i < snaps.length; i++) {
    const prev = snaps[i - 1], curr = snaps[i];
    const codes = new Set([...Object.keys(prev.products), ...Object.keys(curr.products)]);
    for (const code of codes) {
      const prevQty = prev.products[code]?.qty ?? 0;
      const currQty = curr.products[code]?.qty ?? 0;
      const recv    = receivedInPeriod(receipts, code, prev.date, curr.date);
      // 實際銷量 = 期初 + 本期到貨 - 期末（>0 才算）
      const sales   = Math.max(0, prevQty + recv - currQty);
      if (!totalSales[code]) totalSales[code] = 0;
      totalSales[code] += sales;
    }
  }

  const latest = snaps.at(-1);
  const result = { urgent: [], warning: [], planning: [], sufficient: [], noData: [] };

  for (const [code, info] of Object.entries(latest.products)) {
    const currentQty = info.qty;
    if (currentQty <= 0) continue;

    const sales = totalSales[code] ?? 0;
    if (sales === 0 || totalDays === 0) {
      result.noData.push({ code, name: info.name, qty: currentQty });
      continue;
    }

    // 月銷量 = totalSales * (30 / totalDays)
    const monthlyQty = Math.round(sales * 30 / totalDays);
    if (monthlyQty === 0) {
      result.noData.push({ code, name: info.name, qty: currentQty });
      continue;
    }

    const monthsRemaining = parseFloat((currentQty / monthlyQty).toFixed(1));
    const item = {
      code, name: info.name, qty: currentQty, monthlyQty, monthsRemaining,
      order1m: Math.max(0, Math.round(monthlyQty * 1 - currentQty)),
      order3m: Math.max(0, Math.round(monthlyQty * 3 - currentQty)),
      order6m: Math.max(0, Math.round(monthlyQty * 6 - currentQty)),
    };

    if      (monthsRemaining < 1) result.urgent.push(item);
    else if (monthsRemaining < 3) result.warning.push(item);
    else if (monthsRemaining < 6) result.planning.push(item);
    else                           result.sufficient.push(item);
  }

  result.urgent.sort((a, b) => a.monthsRemaining - b.monthsRemaining);
  result.warning.sort((a, b) => a.monthsRemaining - b.monthsRemaining);
  result.planning.sort((a, b) => a.monthsRemaining - b.monthsRemaining);

  return result;
}

// ── 組 HTML Email ─────────────────────────────────────────────────
function buildEmail(r, db) {
  const today = new Date().toISOString().split('T')[0];
  const [year, month, day] = today.split('-');

  const thS = 'background:#f8fafc;padding:8px 10px;text-align:left;font-weight:600;border-bottom:2px solid #e2e8f0;white-space:nowrap;font-size:12px;';
  const tdS = 'padding:7px 10px;border-bottom:1px solid #f1f5f9;font-size:13px;';
  const tdR = tdS + 'text-align:right;';

  const coupangCell = (code) => {
    const co = (db.coupangOrders || {})[code];
    if (!co || co.totalQty <= 0) return `<td style="${tdS}color:#94a3b8;">—</td>`;
    const nextDate = co.orders[0]?.deliveryDate || '';
    return `<td style="${tdS}">
      <span style="display:inline-block;padding:2px 6px;border-radius:8px;font-size:11px;font-weight:600;background:#fff7ed;color:#c2410c;border:1px solid #fed7aa;">酷澎 ${co.totalQty.toLocaleString()}件</span>
      ${nextDate ? `<div style="font-size:10px;color:#94a3b8;margin-top:1px;">交貨 ${nextDate}</div>` : ''}
    </td>`;
  };

  const makeTable = (items) => {
    if (!items.length) return '';
    const rows = items.map(it => `<tr>
      <td style="${tdS}">${esc(it.name)}<br><span style="color:#94a3b8;font-size:11px;">${esc(it.code)}</span></td>
      <td style="${tdR}">${it.qty.toLocaleString()}</td>
      <td style="${tdR}">${it.monthlyQty.toLocaleString()}</td>
      <td style="${tdR}font-weight:600;color:${it.monthsRemaining < 1 ? '#dc2626' : it.monthsRemaining < 3 ? '#d97706' : '#0284c7'};">${it.monthsRemaining} 月</td>
      ${coupangCell(it.code)}
      <td style="${tdR}color:${it.order1m > 0 ? '#dc2626' : '#94a3b8'};font-weight:${it.order1m > 0 ? '700' : '400'};">${it.order1m > 0 ? it.order1m.toLocaleString() : '—'}</td>
      <td style="${tdR}">${it.order3m > 0 ? it.order3m.toLocaleString() : '—'}</td>
      <td style="${tdR}">${it.order6m > 0 ? it.order6m.toLocaleString() : '—'}</td>
    </tr>`).join('');
    return `<table style="width:100%;border-collapse:collapse;">
      <thead><tr>
        <th style="${thS}">商品名稱</th>
        <th style="${thS}text-align:right;">現有庫存</th>
        <th style="${thS}text-align:right;">月銷量</th>
        <th style="${thS}text-align:right;">剩餘月份</th>
        <th style="${thS}">酷澎訂單</th>
        <th style="${thS}text-align:right;">補1個月</th>
        <th style="${thS}text-align:right;">補3個月</th>
        <th style="${thS}text-align:right;">補6個月</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  };

  const urgentHtml  = makeTable(r.urgent);
  const warningHtml = makeTable(r.warning);
  const planningHtml = makeTable(r.planning.slice(0, 30)); // 最多顯示30項

  let sections = '';
  if (urgentHtml) sections += `
    <div style="margin-bottom:24px;">
      <div style="background:#fff5f5;border-left:4px solid #dc2626;border-radius:6px;padding:10px 16px;margin-bottom:10px;color:#dc2626;font-weight:700;font-size:14px;">
        🚨 緊急補貨（${r.urgent.length} 項，剩餘 &lt;1 個月）
      </div>${urgentHtml}
    </div>`;

  if (warningHtml) sections += `
    <div style="margin-bottom:24px;">
      <div style="background:#fffbeb;border-left:4px solid #d97706;border-radius:6px;padding:10px 16px;margin-bottom:10px;color:#d97706;font-weight:700;font-size:14px;">
        ⚠️ 一般補貨（${r.warning.length} 項，剩餘 1–3 個月）
      </div>${warningHtml}
    </div>`;

  if (planningHtml) sections += `
    <div style="margin-bottom:24px;">
      <div style="background:#eff6ff;border-left:4px solid #0284c7;border-radius:6px;padding:10px 16px;margin-bottom:10px;color:#0284c7;font-weight:700;font-size:14px;">
        📋 預備訂貨（${r.planning.length} 項，剩餘 3–6 個月${r.planning.length > 30 ? '，顯示前30項' : ''}）
      </div>${planningHtml}
    </div>`;

  if (!urgentHtml && !warningHtml) {
    sections += `<div style="text-align:center;padding:24px;color:#16a34a;font-size:14px;font-weight:600;">
      本期無緊急或一般補貨需求，庫存狀況良好！✅
    </div>`;
  }

  const summaryRow = [
    { l: '緊急補貨', sub: '<1個月',  c: '#dc2626', n: r.urgent.length },
    { l: '一般補貨', sub: '1–3個月', c: '#d97706', n: r.warning.length },
    { l: '預備訂貨', sub: '3–6個月', c: '#0284c7', n: r.planning.length },
    { l: '庫存充足', sub: '>6個月',  c: '#16a34a', n: r.sufficient.length },
  ].map(s => `<td style="padding:14px;text-align:center;">
    <div style="font-size:28px;font-weight:700;color:${s.c};">${s.n}</div>
    <div style="font-size:11px;color:#64748b;margin-top:3px;">${s.l}</div>
    <div style="font-size:10px;color:#94a3b8;">${s.sub}</div>
  </td>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;margin:0;padding:20px;">
<div style="max-width:750px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1);">
  <div style="background:linear-gradient(135deg,#064e3b,#059669);padding:24px 28px;color:white;">
    <div style="font-size:11px;opacity:.7;margin-bottom:4px;">飛比特 · 庫存管理</div>
    <div style="font-size:22px;font-weight:700;">庫存訂貨建議</div>
    <div style="font-size:13px;opacity:.8;margin-top:4px;">${parseInt(month)}月${parseInt(day)}日 ｜ 報告日：${today} ｜ 共 ${db.snapshotCount} 期快照（${db.snapshots[0].date} ～ ${db.snapshots.at(-1).date}）</div>
  </div>
  <div style="padding:20px 28px;border-bottom:1px solid #f1f5f9;">
    <table style="width:100%;border-collapse:collapse;"><tr>${summaryRow}</tr></table>
  </div>
  <div style="padding:20px 28px;">${sections}</div>
  <div style="background:#f8fafc;padding:14px 28px;font-size:11px;color:#94a3b8;border-top:1px solid #f1f5f9;">
    飛比特庫存管理系統自動生成 ·
    <a href="https://jennifer-shao-ai.github.io/feebit/reorder-suggestions.html" style="color:#2563eb;">查看完整訂貨建議</a>
    ｜
    <a href="https://jennifer-shao-ai.github.io/feebit/slow-mover-alert.html" style="color:#2563eb;">滯銷品警示</a>
  </div>
</div>
</body></html>`;
}

function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

main().catch(e => { console.error('❌', e.message); process.exit(1); });

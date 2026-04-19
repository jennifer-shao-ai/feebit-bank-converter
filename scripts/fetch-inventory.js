// fetch-inventory.js
// 由 GitHub Actions 每月 1 日、15 日自動執行
// Node 20 內建 fetch，不需 npm install

const fs = require('fs');
const path = require('path');

const TOKEN = process.env.RAGIC_TOKEN;
if (!TOKEN) { console.error('❌ RAGIC_TOKEN 未設定'); process.exit(1); }

const PRODUCT_URL = 'https://ap13.ragic.com/feebit50968407/product/16?api&limit=5000';
const DATA_FILE   = path.join(__dirname, '..', 'data', 'inventory-snapshots.json');
const MAX_SNAPS   = 26; // 保留最近 26 筆（約 1 年）

async function main() {
  console.log('🔄 開始抓取 Ragic 商品資料...');

  const res = await fetch(PRODUCT_URL, {
    headers: { Authorization: 'Basic ' + TOKEN }
  });
  if (!res.ok) throw new Error(`Ragic API 回傳 ${res.status}`);

  const raw = await res.json();

  // 整理成 {產品代號: {name, ean, qty, price}} 格式
  const products = {};
  let count = 0;
  for (const [id, row] of Object.entries(raw)) {
    if (id.startsWith('_')) continue;
    const qty = parseInt(row['數量']) || 0;
    const code = String(row['產品代號'] || id).trim();
    if (!code) continue;
    products[code] = {
      name:  (row['產品名稱'] || '').trim(),
      ean:   (row['EAN13碼']  || '').trim(),
      qty,
      price: (row['建議售價'] || '').trim(),
      cost:  (row['成本單價'] || '').trim()
    };
    count++;
  }

  console.log(`✅ 取得 ${count} 項商品`);

  // 讀取現有快照
  let db = { snapshots: [] };
  if (fs.existsSync(DATA_FILE)) {
    try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
    catch { console.warn('⚠️ 現有 JSON 解析失敗，重新建立'); }
  }

  const today = new Date().toISOString().split('T')[0];

  // 同一天重複執行時，覆蓋當天快照
  const idx = db.snapshots.findIndex(s => s.date === today);
  const snap = { date: today, products };
  if (idx >= 0) { db.snapshots[idx] = snap; console.log(`♻️ 覆蓋當天快照（${today}）`); }
  else           { db.snapshots.push(snap); }

  // 按日期排序，只保留最近 N 筆
  db.snapshots.sort((a, b) => a.date.localeCompare(b.date));
  if (db.snapshots.length > MAX_SNAPS) db.snapshots = db.snapshots.slice(-MAX_SNAPS);

  db.lastUpdated   = today;
  db.productCount  = count;
  db.snapshotCount = db.snapshots.length;

  // 確保 data/ 資料夾存在
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');

  console.log(`💾 已儲存快照 data/inventory-snapshots.json`);
  console.log(`   共 ${db.snapshots.length} 筆快照，時間範圍：${db.snapshots[0]?.date} ～ ${today}`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });

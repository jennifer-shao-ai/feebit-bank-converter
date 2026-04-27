/**
 * Feebit 工具箱 — 共用身份驗證模組
 * 所有頁面在 <head> 引入此檔即可獲得登入保護。
 * 登入後 Supabase session 存於 localStorage，各頁面的 db client 自動沿用。
 */
(function () {
  // ── 設定（與各頁面 SB_URL / SB_KEY 相同）──
  const SB_URL = 'https://tokhhoyzztaynppcatci.supabase.co';
  const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRva2hob3l6enRheW5wcGNhdGNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUzMDAyODMsImV4cCI6MjA5MDg3NjI4M30.PQB4lJGF3OMatv5wIedCu3zIWq0urrFbniBRYTbNtUU';

  // 以下情況跳過驗證：
  // 1. login.html 本身（避免無限跳轉）
  // 2. travel-planner 的分享/協作連結（既有功能保留）
  const path = location.pathname;
  const qs   = location.search;
  if (path.includes('login.html')) return;
  if (path.includes('travel-planner.html') && (qs.includes('share') || qs.includes('collab'))) return;

  // 立即隱藏頁面，驗證通過後再顯示（避免未授權內容閃過）
  document.documentElement.style.visibility = 'hidden';

  function loginUrl() {
    const base = location.pathname.replace(/\/[^/]*$/, '');
    return base + '/login.html?next=' + encodeURIComponent(location.href);
  }

  async function loadSDK() {
    if (window.supabase) return;
    await new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
      s.onload = ok; s.onerror = fail;
      document.head.appendChild(s);
    });
  }

  function addLogoutUI(session) {
    const topbarRight = document.querySelector('.topbar > div:last-child');
    if (!topbarRight || document.getElementById('_auth_logout')) return;
    const email = (session.user?.email || '').split('@')[0];
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;align-items:center;gap:8px;flex-shrink:0';
    wrap.innerHTML =
      `<span style="font-size:11px;color:var(--gray-500);white-space:nowrap">${email}</span>` +
      `<button id="_auth_logout" class="btn btn-outline" style="font-size:12px;padding:4px 10px;white-space:nowrap">登出</button>`;
    wrap.querySelector('#_auth_logout').onclick = async () => {
      await window._authClient.auth.signOut();
      location.href = loginUrl().split('?')[0];
    };
    topbarRight.insertBefore(wrap, topbarRight.firstChild);
  }

  // finance_viewer 角色：只允許存取 finance-dashboard.html，其他頁面擋掉
  const VIEWER_ROLE = 'finance_viewer';
  const VIEWER_ALLOWED = 'finance-dashboard.html';

  async function run() {
    try {
      await loadSDK();
      window._authClient = window.supabase.createClient(SB_URL, SB_KEY);
      const { data: { session } } = await window._authClient.auth.getSession();
      if (!session) { location.href = loginUrl(); return; }

      const role = session.user?.user_metadata?.role || '';
      const isViewer = role === VIEWER_ROLE;

      // viewer 只能在 finance-dashboard.html，其他頁面導回
      if (isViewer && !path.includes(VIEWER_ALLOWED)) {
        const base = path.replace(/\/[^/]*$/, '');
        location.href = base + '/' + VIEWER_ALLOWED;
        return;
      }

      // viewer 模式：告知頁面隱藏管理功能
      if (isViewer) window._feebitViewerMode = true;

      document.documentElement.style.visibility = '';
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => addLogoutUI(session));
      } else {
        addLogoutUI(session);
      }
    } catch (e) {
      console.error('[auth.js]', e);
      document.documentElement.style.visibility = '';
    }
  }

  run();
})();

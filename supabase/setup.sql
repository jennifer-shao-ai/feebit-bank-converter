-- 飛比特研發筆記 — 資料庫初始化
-- 在 Supabase SQL Editor 執行此檔案

-- 筆記本
CREATE TABLE IF NOT EXISTS notebooks (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  emoji       TEXT DEFAULT '📓',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 筆記
CREATE TABLE IF NOT EXISTS notes (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  notebook_id UUID REFERENCES notebooks(id) ON DELETE CASCADE NOT NULL,
  title       TEXT NOT NULL,
  content     TEXT,
  summary     TEXT,
  source_url  TEXT,
  source_type TEXT CHECK (source_type IN ('url','image','youtube','manual')) DEFAULT 'manual',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 全文搜尋索引
CREATE INDEX IF NOT EXISTS notes_fts ON notes
  USING gin(to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(content,'')));

-- 開放讀寫（anon 可使用，此為個人工具無需驗證）
ALTER TABLE notebooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "allow all on notebooks" ON notebooks FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow all on notes" ON notes FOR ALL USING (true) WITH CHECK (true);

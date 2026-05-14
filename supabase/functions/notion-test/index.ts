import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

serve(async () => {
  const token = Deno.env.get('NOTION_TOKEN')!

  // 搜尋所有 Integration 可以存取的資料庫
  const searchRes = await fetch('https://api.notion.com/v1/search', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ filter: { value: 'database', property: 'object' } }),
  })
  const search = await searchRes.json()

  const databases = (search.results || []).map((db: any) => ({
    id: db.id,
    title: db.title?.[0]?.plain_text ?? '無標題',
  }))

  return new Response(JSON.stringify({ databases }, null, 2), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  })
})

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { content, title } = await req.json()
    if (!content) throw new Error('content is required')

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY 未設定')

    // Limit input to save tokens
    const truncated = content.length > 6000 ? content.slice(0, 6000) + '\n...' : content

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: `你是飛比特電商的商品研發助理。請針對以下資料，用繁體中文整理出：
1. 核心重點（條列，最多 5 點）
2. 對選品或研發的啟示（1-2 句）

資料標題：${title}
---
${truncated}
---
請直接給整理結果，不要說「以下是...」等開場白。`
        }]
      })
    })

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`Claude API 錯誤: ${errText}`)
    }

    const data = await res.json()
    const summary = data.content[0].text

    return new Response(JSON.stringify({ summary }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})

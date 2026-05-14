import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const NOTION_TOKEN = Deno.env.get('NOTION_TOKEN')!
const NOTION_DATABASE_ID = Deno.env.get('NOTION_DATABASE_ID')!
const GROQ_API_KEY = Deno.env.get('GROQ_API_KEY')!
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!

// ── 平台偵測 ───────────────────────────────────────────────
function detectPlatform(url: string): string {
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'YouTube'
  if (url.includes('facebook.com') || url.includes('fb.watch') || url.includes('fb.me')) return 'Facebook'
  if (url.includes('instagram.com')) return 'Instagram'
  if (url.includes('tiktok.com')) return 'TikTok'
  return '其他'
}

// ── YouTube 字幕擷取 ────────────────────────────────────────
function extractYouTubeId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
  ]
  for (const p of patterns) {
    const match = url.match(p)
    if (match) return match[1]
  }
  return null
}

async function getYouTubeTranscript(url: string): Promise<{ title: string; transcript: string }> {
  const videoId = extractYouTubeId(url)
  if (!videoId) throw new Error('無法解析 YouTube 影片 ID')

  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
    },
  })
  const html = await pageRes.text()

  const titleMatch = html.match(/"title":"(.*?)"/)
  const title = titleMatch
    ? titleMatch[1].replace(/\\u0026/g, '&').replace(/\\"/g, '"')
    : `YouTube: ${videoId}`

  const captionsMatch = html.match(/"captionTracks":\[(.*?)\]/)
  if (!captionsMatch) return { title, transcript: '' }

  const tracksJson = `[${captionsMatch[1]}]`
  const langPriority: Record<string, number> = { 'zh-TW': 3, 'zh-Hant': 3, 'zh': 2, 'en': 1 }
  let baseUrl = ''
  let bestScore = -1

  for (const m of tracksJson.matchAll(/"baseUrl":"(.*?)","name".*?"languageCode":"(.*?)"/g)) {
    const captUrl = m[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/')
    const score = langPriority[m[2]] ?? 0
    if (score > bestScore) { bestScore = score; baseUrl = captUrl }
  }

  if (!baseUrl) {
    const firstUrl = tracksJson.match(/"baseUrl":"(.*?)"/)
    if (!firstUrl) return { title, transcript: '' }
    baseUrl = firstUrl[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/')
  }

  const xml = await (await fetch(baseUrl)).text()
  const lines = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)]
    .map(m =>
      m[1]
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/<[^>]+>/g, '').trim()
    ).filter(Boolean)

  let transcript = lines.join('\n')
  if (transcript.length > 8000) transcript = transcript.slice(0, 8000) + '\n[字幕已截斷...]'

  return { title, transcript }
}

// ── Open Graph 擷取（Facebook / IG / TikTok 用）─────────────
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
}

async function getOpenGraphData(url: string): Promise<{ title: string; description: string; image: string }> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
      },
    })
    const html = await res.text()
    const titleMatch = html.match(/og:title[^>]+content="([^"]+)"/)
      || html.match(/content="([^"]+)"[^>]+og:title/)
    const descMatch = html.match(/og:description[^>]+content="([^"]+)"/)
      || html.match(/content="([^"]+)"[^>]+og:description/)
    const imageMatch = html.match(/og:image[^>]+content="([^"]+)"/)
      || html.match(/content="([^"]+)"[^>]+og:image/)
    return {
      title: decodeHtmlEntities(titleMatch?.[1]?.trim() || ''),
      description: decodeHtmlEntities(descMatch?.[1]?.trim() || ''),
      image: imageMatch?.[1]?.trim() || '',
    }
  } catch {
    return { title: '', description: '', image: '' }
  }
}

// ── Groq Whisper 語音轉錄（用於可直接存取的影片檔） ────────
async function transcribeWithGroq(audioUrl: string): Promise<string> {
  const audioRes = await fetch(audioUrl)
  if (!audioRes.ok) throw new Error('無法下載影片音訊')

  const audioBlob = await audioRes.blob()
  const formData = new FormData()
  formData.append('file', audioBlob, 'audio.mp4')
  formData.append('model', 'whisper-large-v3-turbo')
  formData.append('response_format', 'text')
  formData.append('language', 'zh')

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
    body: formData,
  })

  if (!res.ok) throw new Error('Groq 轉錄失敗')
  return await res.text()
}

// ── Claude 分析：摘要 + 分類 + 重點 ────────────────────────
async function analyzeWithClaude(title: string, transcript: string, platform: string, description = '') {
  const content = transcript
    ? `影片標題：${title}\n\n逐字稿：\n${transcript}`
    : `影片標題：${title}\n來源平台：${platform}\n影片描述：${description || '無'}\n（無逐字稿，請根據標題與描述判斷）`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `分析以下影片內容，用繁體中文回覆，只回傳 JSON，不要加任何說明：

${content}

回覆格式：
{
  "category": "從以下選最符合的一個：管理、工具、日本、美食、穴道、運動",
  "summary": "2-3 句摘要",
  "keyPoints": ["重點1", "重點2", "重點3"]
}`,
      }],
    }),
  })

  if (!res.ok) throw new Error(`Claude API 錯誤: ${await res.text()}`)
  const data = await res.json()
  const text = data.content[0].text
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Claude 回覆格式錯誤')
  return JSON.parse(jsonMatch[0])
}

// ── 儲存至 Notion ───────────────────────────────────────────
async function saveToNotion({
  title, url, platform, category, summary, keyPoints, thumbnailUrl = '',
}: {
  title: string; url: string; platform: string
  category: string; summary: string; keyPoints: string[]; thumbnailUrl?: string
}) {
  const keyPointsText = keyPoints.map((p, i) => `${i + 1}. ${p}`).join('\n')

  const body: Record<string, unknown> = {
    parent: { database_id: NOTION_DATABASE_ID },
    properties: {
      '影片標題': { title: [{ text: { content: title } }] },
      '影片連結': { url },
      '分類': { select: { name: category } },
      '平台': { select: { name: platform } },
      '摘要': { rich_text: [{ text: { content: summary } }] },
      '重點': { rich_text: [{ text: { content: keyPointsText } }] },
    },
    children: [] as unknown[],
  }

  // 嵌入影片
  if (platform === 'YouTube') {
    ;(body.children as unknown[]).push({
      object: 'block',
      type: 'video',
      video: { type: 'external', external: { url } },
    })
  } else {
    // Facebook / IG / TikTok：縮圖 + 連結
    ;(body.children as unknown[]).push({
      object: 'block',
      type: 'bookmark',
      bookmark: { url },
    })
  }

  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) throw new Error(`Notion 儲存失敗: ${await res.text()}`)
}

// ── 主程式 ──────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    // 支援多種格式：純文字 body / JSON body / GET query param
    let url: string
    if (req.method === 'GET') {
      url = new URL(req.url).searchParams.get('url') ?? ''
    } else {
      const raw = await req.text()
      if (raw.trim().startsWith('{')) {
        url = JSON.parse(raw).url ?? ''
      } else {
        url = raw.trim()
      }
    }
    // 清除可能包含的換行或多餘空白
    url = url.replace(/\s+/g, '').trim()
    if (!url) throw new Error('缺少影片網址')

    const platform = detectPlatform(url)
    let title = ''
    let transcript = ''
    let description = ''
    let thumbnailUrl = ''

    if (platform === 'YouTube') {
      const info = await getYouTubeTranscript(url)
      title = info.title
      transcript = info.transcript
    } else {
      // Facebook / Instagram / TikTok：抓 Open Graph 標題與描述
      const og = await getOpenGraphData(url)
      title = og.title || url
      description = og.description
      thumbnailUrl = og.image
    }

    const analysis = await analyzeWithClaude(title, transcript, platform, description)
    await saveToNotion({ title: title || url, url, platform, thumbnailUrl, ...analysis })

    return new Response(
      JSON.stringify({ success: true, title, platform, ...analysis }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
  ]
  for (const p of patterns) {
    const match = url.match(p)
    if (match) return match[1]
  }
  return null
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { url } = await req.json()
    if (!url) throw new Error('url is required')

    const videoId = extractVideoId(url)
    if (!videoId) throw new Error('無法解析 YouTube 影片 ID')

    // Fetch YouTube page
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
      }
    })
    const html = await pageRes.text()

    // Extract video title
    const titleMatch = html.match(/"title":"(.*?)"/)
    const title = titleMatch ? titleMatch[1].replace(/\\u0026/g, '&').replace(/\\"/g, '"') : `YouTube: ${videoId}`

    // Find caption tracks
    const captionsMatch = html.match(/"captionTracks":\[(.*?)\]/)
    if (!captionsMatch) {
      throw new Error('此影片沒有字幕（可能是私人影片或未開啟字幕）')
    }

    // Find a suitable caption URL (prefer zh-TW, zh, then en)
    const tracksJson = `[${captionsMatch[1]}]`
    let baseUrl = ''
    let bestScore = -1

    const langPriority: Record<string, number> = { 'zh-TW': 3, 'zh-Hant': 3, 'zh': 2, 'en': 1 }

    const urlMatches = tracksJson.matchAll(/"baseUrl":"(.*?)","name".*?"languageCode":"(.*?)"/g)
    for (const m of urlMatches) {
      const captUrl = m[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/')
      const lang = m[2]
      const score = langPriority[lang] ?? 0
      if (score > bestScore) {
        bestScore = score
        baseUrl = captUrl
      }
    }

    if (!baseUrl) {
      // Just grab the first baseUrl found
      const firstUrl = tracksJson.match(/"baseUrl":"(.*?)"/)
      if (!firstUrl) throw new Error('找不到字幕連結')
      baseUrl = firstUrl[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/')
    }

    // Fetch captions XML
    const captRes = await fetch(baseUrl)
    const xml = await captRes.text()

    // Parse XML text nodes
    const textMatches = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)]
    const lines = textMatches.map(m =>
      m[1]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/<[^>]+>/g, '')
        .trim()
    ).filter(Boolean)

    let transcript = lines.join('\n')

    // Limit to 8000 chars
    if (transcript.length > 8000) {
      transcript = transcript.slice(0, 8000) + '\n\n[字幕已截斷...]'
    }

    return new Response(JSON.stringify({ title, transcript, videoId }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})

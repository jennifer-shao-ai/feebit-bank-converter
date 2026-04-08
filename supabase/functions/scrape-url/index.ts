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
    const { url } = await req.json()
    if (!url) throw new Error('url is required')

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
      },
    })

    const html = await response.text()

    // Extract title (og:title preferred over <title>)
    const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is)
    const rawTitle = ogTitleMatch ? ogTitleMatch[1] : (titleMatch ? titleMatch[1] : url)
    const title = rawTitle.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#[0-9]+;/g, '').trim()

    // Extract og:image (product image — set by the site, most reliable for e-commerce)
    const ogImageMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
    const image = ogImageMatch ? ogImageMatch[1].trim() : ''

    // Extract og:description
    const ogDescMatch = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i)
      || html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)
    const description = ogDescMatch ? ogDescMatch[1].trim() : ''

    // Extract image URLs before stripping tags
    const images: string[] = []
    const imgRegex = /<img([^>]+)>/gi
    let imgMatch: RegExpExecArray | null
    while ((imgMatch = imgRegex.exec(html)) !== null) {
      const tag = imgMatch[1]
      // Skip 1x1 tracking pixels
      if (/\bwidth=["']?1["']?\b/i.test(tag) || /\bheight=["']?1["']?\b/i.test(tag)) continue
      const srcMatch = tag.match(/\bsrc=["']([^"']+)["']/i)
      if (!srcMatch) continue
      let src = srcMatch[1].trim()
      if (!src || src.startsWith('data:')) continue
      // Resolve relative URLs
      try { src = new URL(src, url).href } catch { continue }
      if (!src.startsWith('http')) continue
      if (!images.includes(src)) images.push(src)
      if (images.length >= 8) break
    }

    // Remove scripts, styles, nav, footer
    let content = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#[0-9]+;/g, '')
      .replace(/\s{2,}/g, '\n')
      .trim()

    // Limit to 8000 chars to save tokens
    if (content.length > 8000) {
      content = content.slice(0, 8000) + '\n\n[內容已截斷...]'
    }

    return new Response(JSON.stringify({ title, content, image, description }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})

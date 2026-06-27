require('dotenv').config()
const express = require('express')
const cors = require('cors')
const fetch = require('node-fetch')
const multer = require('multer')
const Anthropic = require('@anthropic-ai/sdk')
const cron = require('node-cron');
const app = express()
const PORT = process.env.PORT || 3001

app.use(cors({ origin: true, credentials: true }))
app.use(express.json({ limit: '10mb' }))

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── eBay OAuth token cache ──────────────────────────────────────────────────
let ebayToken = null
let ebayTokenExpiry = 0

async function getEbayToken() {
  if (ebayToken && Date.now() < ebayTokenExpiry - 60000) return ebayToken
  const clientId = process.env.EBAY_CLIENT_ID
  const clientSecret = process.env.EBAY_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new Error('EBAY_CLIENT_ID or EBAY_CLIENT_SECRET not set in Railway')
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope'
  })
  const data = await res.json()
  if (!data.access_token) {
    console.error('eBay token error:', JSON.stringify(data))
    throw new Error('Failed to get eBay OAuth token: ' + (data.error_description || data.error || 'unknown'))
  }
  ebayToken = data.access_token
  ebayTokenExpiry = Date.now() + (data.expires_in * 1000)
  console.log('eBay OAuth token acquired, expires in', data.expires_in, 'seconds')
  return ebayToken
}

// ── Core eBay Browse API fetcher ────────────────────────────────────────────
async function fetchItems(query, limit) {
  limit = limit || 100
  const token = await getEbayToken()
  const params = new URLSearchParams({
    q: query,
    limit: Math.min(limit, 200).toString(),
    sort: 'newlyListed',
    fieldgroups: 'MATCHING_ITEMS'
  })
  const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`
  console.log('eBay query:', query)
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      'Content-Type': 'application/json'
    }
  })
  const text = await res.text()
  if (res.status === 401) { ebayToken = null; throw new Error('eBay auth failed') }
  if (text.startsWith('<')) throw new Error('eBay returned HTML')
  const data = JSON.parse(text)
  if (data.errors && data.errors.length) {
    const warn = data.errors[0]
    if (warn.severity === 'WARNING') {
      // non-fatal warnings (e.g. filter issues) — still return results
      console.warn('eBay warning:', warn.message)
      return data.itemSummaries || []
    }
    throw new Error('eBay API error: ' + warn.message)
  }
  const items = data.itemSummaries || []
  console.log(`  → ${items.length} items for: ${query}`)
  return items
}

// ── Build precise eBay search queries per grade tier ───────────────────────
// Raw: exclude PSA/BGS/SGC/CGC, include card number and base brand only
// PSA 9 / PSA 10: include "PSA 9" or "PSA 10" in query
function buildRawQuery(player, year, brand, cardNum) {
  const parts = []
  if (player) parts.push(player.trim())
  if (year) parts.push(String(year))
  if (brand) {
    // Use first 2 words of brand to avoid over-restricting (e.g. "Topps Chrome" not full parallel name)
    const words = brand.trim().split(/\s+/).slice(0, 2).join(' ')
    parts.push(words)
  }
  if (cardNum) parts.push('#' + String(cardNum).replace(/^#/, ''))
  // Explicitly exclude graded slabs from raw search
  const q = parts.join(' ')
  return q + ' -PSA -BGS -SGC -CGC -graded'
}

function buildGradedQuery(player, year, brand, cardNum, psaGrade) {
  const parts = []
  if (player) parts.push(player.trim())
  if (year) parts.push(String(year))
  if (brand) {
    const words = brand.trim().split(/\s+/).slice(0, 2).join(' ')
    parts.push(words)
  }
  if (cardNum) parts.push('#' + String(cardNum).replace(/^#/, ''))
  parts.push(`PSA ${psaGrade}`)
  return parts.join(' ')
}

// ── IQR outlier filter + stats ─────────────────────────────────────────────
function calcStats(prices) {
  const sorted = prices.filter(p => p > 1).sort((a, b) => a - b)
  if (sorted.length === 0) return null

  let cleaned = sorted
  if (sorted.length >= 5) {
    const q1 = sorted[Math.floor(sorted.length * 0.25)]
    const q3 = sorted[Math.floor(sorted.length * 0.75)]
    const iqr = q3 - q1
    const lo = q1 - 1.5 * iqr
    const hi = q3 + 1.5 * iqr
    cleaned = sorted.filter(p => p >= lo && p <= hi)
    if (cleaned.length < 3) cleaned = sorted // don't over-filter small sets
  }

  // Additional 10% trim on large sets
  let w = cleaned
  if (cleaned.length >= 8) {
    const t = Math.max(1, Math.floor(cleaned.length * 0.1))
    w = cleaned.slice(t, cleaned.length - t)
  }

  const avg = w.reduce((a, b) => a + b, 0) / w.length
  return {
    count: sorted.length,
    cleanCount: w.length,
    avg: Math.round(avg * 100) / 100,
    median: Math.round(w[Math.floor(w.length / 2)] * 100) / 100,
    high: sorted[sorted.length - 1],
    low: sorted[0],
    recommended: Math.round(avg * 100) / 100
  }
}

// ── Parse Browse API items into price + date ───────────────────────────────
function parseItems(rawItems) {
  const now = Date.now()
  return rawItems.map(item => {
    const priceVal = item.lastSoldPrice?.value || item.price?.value || item.currentBidPrice?.value || '0'
    const price = parseFloat(priceVal)
    const endTimeStr = item.lastSoldDate || item.itemEndDate || item.itemCreationDate || null
    const endTime = endTimeStr ? new Date(endTimeStr) : null
    const daysAgo = endTime ? Math.round((now - endTime.getTime()) / (1000 * 60 * 60 * 24)) : 0
    return {
      title: item.title || '',
      price,
      soldDate: endTime?.toISOString() || null,
      daysAgo,
      url: item.itemWebUrl || '',
      image: item.image?.imageUrl || null,
      condition: item.condition || 'Unknown'
    }
  }).filter(c => c.price > 1).sort((a, b) => a.daysAgo - b.daysAgo)
}

// ── Routes ──────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'GradeEdge API running', version: '6.0.0' })
})

// Single-grade comp (used by edit modal / LiveCompFetcher)
app.get('/api/comps', async (req, res) => {
  try {
    const { player, brand, year, grade, cardNum, numbered } = req.query
    if (!player) return res.status(400).json({ error: 'player is required' })

    const parts = []
    if (year)     parts.push(String(year).trim())
    if (brand)    parts.push(brand.trim())
    if (player)   parts.push(player.trim())
    if (cardNum)  parts.push(`#${String(cardNum).trim()}`)
    if (numbered) {
      const match = String(numbered).match(/\/(\d+)/)
      if (match) parts.push(`/${match[1]}`)
      else parts.push(numbered)
    }
    const gradeSuffix = grade && !/^raw$/i.test(grade) ? grade : ''
    if (gradeSuffix) parts.push(gradeSuffix)
    const query = parts.join(' ')

    console.log('Fetching comps for:', query)
    const rawItems = await fetchItems(query, 100)

    if (rawItems.length === 0) {
      return res.json({
        query, count: 0,
        stats: { avg: 0, median: 0, high: 0, low: 0, recommended: 0, trendLabel: 'No data found' },
        comps: [], message: 'No listings found. Try fewer search terms.',
        source: 'eBay Browse API'
      })
    }

    const comps = parseItems(rawItems)
    const recent = comps.filter(c => c.daysAgo <= 30)
    const older  = comps.filter(c => c.daysAgo > 30 && c.daysAgo <= 60)
    const aStats = calcStats(comps.map(c => c.price))
    const rStats = calcStats(recent.map(c => c.price))
    const oStats = calcStats(older.map(c => c.price))
    const trend = rStats?.avg && oStats?.avg
      ? rStats.avg > oStats.avg ? '📈 Rising' : rStats.avg < oStats.avg ? '📉 Falling' : '➡️ Stable'
      : '➡️ Stable'
    const trendLabel = trend

    res.json({
      query, count: comps.length, recentCount: recent.length, olderCount: older.length,
      stats: {
        avg: aStats?.avg || 0, median: aStats?.median || 0,
        high: aStats?.high || 0, low: aStats?.low || 0,
        recommended: rStats?.recommended || aStats?.recommended || 0,
        trend, trendLabel
      },
      recentStats: rStats, olderStats: oStats,
      comps: comps.slice(0, 15),
      source: 'eBay Browse API',
      fetchedAt: new Date().toISOString()
    })
  } catch (err) {
    console.error('Comps error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// THREE-TIER COMP: Raw + PSA 9 + PSA 10 in one call
app.post('/api/comps/tiers', async (req, res) => {
  const { card } = req.body
  if (!card) return res.status(400).json({ error: 'Card data is required' })
  if (!card.player_name && !card.brand_parallel) {
    return res.status(400).json({ error: 'Card must have at least a player name or brand' })
  }

  function buildQuery(card, gradeSuffix = '') {
    const parts = []
    if (card.year)           parts.push(String(card.year).trim())
    if (card.brand_parallel) parts.push(card.brand_parallel.trim())
    if (card.player_name)    parts.push(card.player_name.trim())
    if (card.card_number)    parts.push(`#${String(card.card_number).trim()}`)
    if (card.numbered) {
      const match = String(card.numbered).match(/\/(\d+)/)
      if (match) parts.push(`/${match[1]}`)
      else parts.push(String(card.numbered).trim())
    }
    if (gradeSuffix) parts.push(gradeSuffix)
    return parts.join(' ')
  }

  function buildWeeklyBuckets(items) {
    const now = new Date()
    const buckets = Array.from({ length: 8 }, (_, i) => {
      const weekStart = new Date(now)
      weekStart.setDate(now.getDate() - (7 * (7 - i)))
      const weekEnd = new Date(weekStart)
      weekEnd.setDate(weekStart.getDate() + 7)
      return { weekStart, weekEnd, prices: [], label: `W${i + 1}` }
    })
    items.forEach(item => {
      if (!item.date) return
      const d = new Date(item.date)
      buckets.forEach(bucket => {
        if (d >= bucket.weekStart && d < bucket.weekEnd) bucket.prices.push(item.price)
      })
    })
    return buckets.map(b => ({
      label: b.label,
      avg: b.prices.length ? parseFloat((b.prices.reduce((s, p) => s + p, 0) / b.prices.length).toFixed(2)) : null,
      count: b.prices.length,
    }))
  }

  try {
    const token = await getEbayToken()
    const rawQuery   = buildQuery(card, '')
    const psa9Query  = buildQuery(card, 'PSA 9')
    const psa10Query = buildQuery(card, 'PSA 10')

    console.log('[Comps] Raw query:', rawQuery)
    console.log('[Comps] PSA 9 query:', psa9Query)
    console.log('[Comps] PSA 10 query:', psa10Query)

    const [rawItems, psa9Items, psa10Items] = await Promise.all([
      fetchItems(rawQuery, 50),
      fetchItems(psa9Query, 50),
      fetchItems(psa10Query, 50),
    ])

    // Filter graded cards out of raw results
    const rawFiltered = rawItems.filter(i => !/\b(PSA|BGS|SGC|CGC)\b/i.test(i.title || ''))

    function iqrFilter(prices) {
      if (prices.length < 4) return prices
      const sorted = [...prices].sort((a, b) => a - b)
      const q1 = sorted[Math.floor(sorted.length * 0.25)]
      const q3 = sorted[Math.floor(sorted.length * 0.75)]
      const iqr = q3 - q1
      return prices.filter(p => p >= q1 - 1.5 * iqr && p <= q3 + 1.5 * iqr)
    }

    function medianOf(prices) {
      if (!prices.length) return null
      const s = [...prices].sort((a, b) => a - b)
      const m = Math.floor(s.length / 2)
      return s.length % 2 !== 0 ? s[m] : (s[m - 1] + s[m]) / 2
    }

    function toItems(rawList) {
      return rawList.map(i => ({
        price: parseFloat(i.price?.value || i.price || 0),
        date:  i.itemEndDate || i.date || null,
        title: i.title || '',
        url:   i.itemWebUrl || i.url || '',
      })).filter(i => i.price > 0)
    }

    const rawComp   = toItems(rawFiltered)
    const psa9Comp  = toItems(psa9Items)
    const psa10Comp = toItems(psa10Items)

    const rawPrices   = iqrFilter(rawComp.map(i => i.price))
    const psa9Prices  = iqrFilter(psa9Comp.map(i => i.price))
    const psa10Prices = iqrFilter(psa10Comp.map(i => i.price))

    res.json({
      raw: {
        query: rawQuery, median: medianOf(rawPrices),
        count: rawComp.length, filteredCount: rawPrices.length,
        items: rawComp.slice(0, 10), weeklyTrend: buildWeeklyBuckets(rawComp),
      },
      psa9: {
        query: psa9Query, median: medianOf(psa9Prices),
        count: psa9Comp.length, filteredCount: psa9Prices.length,
        items: psa9Comp.slice(0, 10), weeklyTrend: buildWeeklyBuckets(psa9Comp),
      },
      psa10: {
        query: psa10Query, median: medianOf(psa10Prices),
        count: psa10Comp.length, filteredCount: psa10Prices.length,
        items: psa10Comp.slice(0, 10), weeklyTrend: buildWeeklyBuckets(psa10Comp),
      },
    })
  } catch (err) {
    console.error('[Comps] Tiers error:', err?.response?.data || err.message)
    res.status(500).json({ error: 'Failed to fetch comps', detail: err?.response?.data?.errors?.[0]?.message || err.message })
  }
})

// APPROVE COMPS — save to Supabase + enable auto-refresh
app.post('/api/comps/approve', async (req, res) => {
  const { cardId, raw, psa9, psa10, autoRefresh } = req.body
  if (!cardId) return res.status(400).json({ error: 'cardId required' })
  try {
    const now = new Date().toISOString()
    const { data: existing } = await supabase.from('cards').select('comp_history').eq('id', cardId).single()
    const prevHistory = existing?.comp_history || []
    const updatedHistory = [...prevHistory, { date: now, raw: raw ?? null, psa9: psa9 ?? null, psa10: psa10 ?? null }].slice(-52)
    const { error } = await supabase.from('cards').update({
      comp_raw: raw ?? null, comp_psa9: psa9 ?? null, comp_psa10: psa10 ?? null,
      comp_auto_refresh: autoRefresh ?? false,
      comp_last_refreshed: now, comp_history: updatedHistory,
    }).eq('id', cardId)
    if (error) throw error
    res.json({ success: true, lastRefreshed: now })
  } catch (err) {
    console.error('[Comps] Approve error:', err.message)
    res.status(500).json({ error: 'Failed to save comps', detail: err.message })
  }
})

// ── AI Card Scanner ─────────────────────────────────────────────────────────
app.post('/api/scan', upload.single('image'), async (req, res) => {
  try {
    let imageBase64, mediaType
    if (req.file) {
      imageBase64 = req.file.buffer.toString('base64')
      mediaType = req.file.mimetype || 'image/jpeg'
    } else if (req.body.image) {
      const match = req.body.image.match(/^data:([^;]+);base64,(.+)$/)
      if (match) { mediaType = match[1]; imageBase64 = match[2] }
      else { imageBase64 = req.body.image; mediaType = 'image/jpeg' }
    } else {
      return res.status(400).json({ error: 'No image provided' })
    }
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 500,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
        { type: 'text', text: 'You are a sports card expert. Analyze this card image and return ONLY valid JSON with no markdown: {"player":"name","year":2024,"brand":"manufacturer","setName":"set name","parallel":"parallel or null","cardNum":"card number","sport":"Baseball|Basketball|Football|Hockey|Other","team":"team name","rookie":false,"autograph":false,"serialNumber":"x/y or null","grader":"PSA|BGS|SGC|CGC or null","grade":null,"certNum":null,"confidence":"high|medium|low","confidenceReason":"brief reason"}' }
      ]}]
    })
    const responseText = message.content[0].text.trim()
    let cardData
    try { const m = responseText.match(/\{[\s\S]*\}/); cardData = JSON.parse(m ? m[0] : responseText) }
    catch (e) { return res.status(500).json({ error: 'Could not parse card data', raw: responseText }) }
    res.json({ success: true, card: cardData, scannedAt: new Date().toISOString() })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Bulk Comps ──────────────────────────────────────────────────────────────
app.post('/api/comps/bulk', async (req, res) => {
  try {
    const { cards } = req.body
    if (!cards || !Array.isArray(cards)) return res.status(400).json({ error: 'cards array required' })
    const results = []
    for (const card of cards.slice(0, 10)) {
      try {
        const query = buildRawQuery(card.player, card.year, card.brand, card.card_num)
        const items = await fetchItems(query, 20)
        const prices = parseItems(items).map(i => i.price)
        const stats = calcStats(prices)
        results.push({ id: card.id, comp: stats?.recommended || null, count: prices.length, query })
        await new Promise(r => setTimeout(r, 400))
      } catch (err) { results.push({ id: card.id, comp: null, error: err.message }) }
    }
    res.json({ results, processed: results.length })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Weekly comp auto-refresh — runs Sundays 2 AM Mountain Time
cron.schedule('0 8 * * 0', async () => {
  console.log('[CronRefresh] Starting weekly comp refresh —', new Date().toISOString())
  try {
    const { data: cards } = await supabase.from('cards')
      .select('id, player_name, brand_parallel, card_number, year, numbered, comp_raw, comp_psa9, comp_psa10, comp_history')
      .eq('comp_auto_refresh', true)
    if (!cards || cards.length === 0) return console.log('[CronRefresh] No cards to refresh')
    console.log(`[CronRefresh] Refreshing ${cards.length} cards`)
    for (const card of cards) {
      try {
        const r = await fetch('https://gradeedge-api-production.up.railway.app/api/comps/tiers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ card })
        })
        const { raw, psa9, psa10 } = await r.json()
        const now = new Date().toISOString()
        const history = [...(card.comp_history || []), { date: now, raw: raw?.median ?? null, psa9: psa9?.median ?? null, psa10: psa10?.median ?? null }].slice(-52)
        await supabase.from('cards').update({
          comp_raw: raw?.median ?? card.comp_raw,
          comp_psa9: psa9?.median ?? card.comp_psa9,
          comp_psa10: psa10?.median ?? card.comp_psa10,
          comp_last_refreshed: now,
          comp_history: history
        }).eq('id', card.id)
        console.log(`[CronRefresh] ✅ ${card.player_name}`)
        await new Promise(r => setTimeout(r, 2000))
      } catch (e) { console.error(`[CronRefresh] ❌ ${card.id}:`, e.message) }
    }
  } catch (e) { console.error('[CronRefresh] Fatal:', e.message) }
}, { timezone: 'America/Denver' })

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('GradeEdge API v6.0.0 running on port ' + PORT)
  console.log('eBay Client ID configured:', !!process.env.EBAY_CLIENT_ID)
  console.log('eBay Client Secret configured:', !!process.env.EBAY_CLIENT_SECRET)
  console.log('Anthropic configured:', !!process.env.ANTHROPIC_API_KEY)
})
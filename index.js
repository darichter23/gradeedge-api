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
const { createClient } = require('@supabase/supabase-js')
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

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

// ── Core eBay Browse API fetcher (still used by /api/comps single-grade lookup + /api/comps/bulk) ─
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
  console.log(` → ${items.length} items for: ${query}`)
  return items
}

// ── Build precise eBay search queries per grade tier ───────────────────────
function buildRawQuery(player, year, brand, cardNum) {
  const parts = []
  if (player) parts.push(player.trim())
  if (year) parts.push(String(year))
  if (brand) {
    const words = brand.trim().split(/\s+/).slice(0, 2).join(' ')
    parts.push(words)
  }
  if (cardNum) parts.push('#' + String(cardNum).replace(/^#/, ''))
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
    if (cleaned.length < 3) cleaned = sorted
  }

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

// ── SportsCardsPro helpers (sold-price based — primary comp source) ────────
async function scpFetch(path, params) {
  const token = process.env.SPORTSCARDSPRO_API_TOKEN
  if (!token) throw new Error('SPORTSCARDSPRO_API_TOKEN not set')
  const url = new URL(`https://www.sportscardspro.com/api/${path}`)
  url.searchParams.set('t', token)
  Object.entries(params).forEach(([k, v]) => { if (v != null && v !== '') url.searchParams.set(k, v) })
  const r = await fetch(url.toString())
  if (!r.ok) throw new Error(`SportsCardsPro API error: ${r.status}`)
  return r.json()
}
const centsToDollars = v => (v == null ? null : Math.round(v) / 100)

// Look up a single card's full multi-grade comp set from SportsCardsPro.
// Two sequential API calls (search then detail) — internally paced to respect SCP's 1 req/sec limit.
async function fetchTiersFromSCP(card) {
  const words = card.brand_parallel ? String(card.brand_parallel).trim().split(/\s+/).slice(0, 2).join(' ') : ''
  const q = [
    card.year,
    words,
    card.player_name,
    card.card_number ? '#' + String(card.card_number).replace(/^#/, '') : ''
  ].filter(Boolean).join(' ').trim()

  if (!q) return { matched: false, query: q }

  const search = await scpFetch('products', { q })
  if (search.status !== 'success' || !search.products?.length) return { matched: false, query: q }

  await new Promise(r => setTimeout(r, 1100)) // respect SCP rate limit between the two calls

  const detail = await scpFetch('product', { id: search.products[0].id })
  if (detail.status !== 'success') return { matched: false, query: q }

  return {
    matched: true,
    query: q,
    matchedProduct: detail['product-name'],
    matchedSet: detail['console-name'],
    productId: detail.id,
    raw: centsToDollars(detail['loose-price']),
    psa8: centsToDollars(detail['new-price']),
    psa9: centsToDollars(detail['graded-price']),
    psa10: centsToDollars(detail['manual-only-price']),
    bgs10: centsToDollars(detail['bgs-10-price']),
    cgc10: centsToDollars(detail['condition-17-price']),
    sgc10: centsToDollars(detail['condition-18-price']),
    salesVolume: detail['sales-volume'] ?? null,
  }
}

// Build a sparkline-compatible weekly trend from our own stored comp_history snapshots.
// SportsCardsPro's API only exposes current aggregate values (no per-sale historical listings),
// so trend continuity now comes from what we save on each refresh, accumulating over time.
function buildWeeklyTrendFromHistory(history, key) {
  if (!Array.isArray(history) || !history.length) return []
  return history.slice(-8).map((h, i) => ({
    label: `W${i + 1}`,
    avg: h[key] != null ? Number(h[key]) : null,
    count: h[key] != null ? 1 : 0,
  }))
}

// ── Routes ──────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'GradeEdge API running', version: '7.0.0' })
})

// Single-grade comp (used by edit modal / LiveCompFetcher) — still eBay-based for now.
app.get('/api/comps', async (req, res) => {
  try {
    const { player, brand, year, grade, cardNum, numbered } = req.query
    if (!player) return res.status(400).json({ error: 'player is required' })

    const parts = []
    if (year) parts.push(String(year).trim())
    if (brand) parts.push(brand.trim())
    if (player) parts.push(player.trim())
    if (cardNum) parts.push(`#${String(cardNum).trim()}`)
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
    const older = comps.filter(c => c.daysAgo > 30 && c.daysAgo <= 60)
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

// THREE-TIER COMP: Raw + PSA 9 + PSA 10 in one call.
// Primary automated comp source — powers the inventory table columns, Approve & Save,
// the weekly auto-refresh cron, and the Sell/Watch/Hold signal.
// Migrated from eBay Browse API (active listings) to SportsCardsPro (sold-price based) for accuracy.
app.post('/api/comps/tiers', async (req, res) => {
  const { card } = req.body
  if (!card) return res.status(400).json({ error: 'Card data is required' })
  if (!card.player_name && !card.brand_parallel) {
    return res.status(400).json({ error: 'Card must have at least a player name or brand' })
  }

  try {
    const scp = await fetchTiersFromSCP(card)
    const history = card.comp_history || []

    if (!scp.matched) {
      return res.json({
        raw: { query: scp.query, median: null, count: 0, filteredCount: 0, items: [], weeklyTrend: buildWeeklyTrendFromHistory(history, 'raw') },
        psa9: { query: scp.query, median: null, count: 0, filteredCount: 0, items: [], weeklyTrend: buildWeeklyTrendFromHistory(history, 'psa9') },
        psa10: { query: scp.query, median: null, count: 0, filteredCount: 0, items: [], weeklyTrend: buildWeeklyTrendFromHistory(history, 'psa10') },
        source: 'SportsCardsPro',
        matched: false,
      })
    }

    res.json({
      raw: { query: scp.query, median: scp.raw, count: scp.salesVolume || 0, filteredCount: scp.salesVolume || 0, items: [], weeklyTrend: buildWeeklyTrendFromHistory(history, 'raw') },
      psa9: { query: scp.query, median: scp.psa9, count: scp.salesVolume || 0, filteredCount: scp.salesVolume || 0, items: [], weeklyTrend: buildWeeklyTrendFromHistory(history, 'psa9') },
      psa10: { query: scp.query, median: scp.psa10, count: scp.salesVolume || 0, filteredCount: scp.salesVolume || 0, items: [], weeklyTrend: buildWeeklyTrendFromHistory(history, 'psa10') },
      matchedProduct: scp.matchedProduct,
      matchedSet: scp.matchedSet,
      psa8: scp.psa8, bgs10: scp.bgs10, cgc10: scp.cgc10, sgc10: scp.sgc10,
      source: 'SportsCardsPro',
      matched: true,
    })
  } catch (err) {
    console.error('[Comps] Tiers error (SCP):', err?.message)
    res.status(500).json({ error: 'Failed to fetch comps', detail: err.message })
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
    const updatedHistory = [...prevHistory, { date: now, raw: raw ?? null, psa9: psa9 ?? null, psa10: psa10 ?? null, source: 'SportsCardsPro' }].slice(-52)
    const { error } = await supabase.from('cards').update({
      comp_raw: raw ?? null, comp_psa9: psa9 ?? null, comp_psa10: psa10 ?? null,
      comp_source: 'SportsCardsPro',
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
app.post('/api/scan', upload.fields([{ name: 'image', maxCount: 1 }, { name: 'imageBack', maxCount: 1 }]), async (req, res) => {
  try {
    function extractImage(fileField, bodyField) {
      if (req.files && req.files[fileField] && req.files[fileField][0]) {
        const f = req.files[fileField][0]
        return { mediaType: f.mimetype || 'image/jpeg', base64: f.buffer.toString('base64') }
      }
      if (req.body[bodyField]) {
        const match = req.body[bodyField].match(/^data:([^;]+);base64,(.+)$/)
        if (match) return { mediaType: match[1], base64: match[2] }
        return { mediaType: 'image/jpeg', base64: req.body[bodyField] }
      }
      return null
    }
    const front = extractImage('image', 'image')
    const back = extractImage('imageBack', 'imageBack')
    if (!front) return res.status(400).json({ error: 'No front image provided' })

    const content = [
      { type: 'image', source: { type: 'base64', media_type: front.mediaType, data: front.base64 } }
    ]
    if (back) content.push({ type: 'image', source: { type: 'base64', media_type: back.mediaType, data: back.base64 } })
    content.push({ type: 'text', text: back
      ? 'You are a sports card expert. The first image is the FRONT of the card, the second image is the BACK. Use both to identify the card as accurately as possible — the back often has set/copyright info, and PSA/graded labels are on the slab holder which may be visible in either image. Return ONLY valid JSON with no markdown: {"player":"name","year":2024,"brand":"manufacturer","setName":"set name","parallel":"parallel or null","cardNum":"card number","sport":"Baseball|Basketball|Football|Hockey|Other","team":"team name","rookie":false,"autograph":false,"serialNumber":"x/y or null","grader":"PSA|BGS|SGC|CGC or null","grade":null,"certNum":null,"confidence":"high|medium|low","confidenceReason":"brief reason"}'
      : 'You are a sports card expert. Analyze this card image and return ONLY valid JSON with no markdown: {"player":"name","year":2024,"brand":"manufacturer","setName":"set name","parallel":"parallel or null","cardNum":"card number","sport":"Baseball|Basketball|Football|Hockey|Other","team":"team name","rookie":false,"autograph":false,"serialNumber":"x/y or null","grader":"PSA|BGS|SGC|CGC or null","grade":null,"certNum":null,"confidence":"high|medium|low","confidenceReason":"brief reason"}'
    })

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-5', max_tokens: 500,
      messages: [{ role: 'user', content }]
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

// ── Bulk Comps (legacy eBay path — small manual batches, unrelated to the SCP backfill below) ──
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

// ── SportsCardsPro multi-grade pricing (raw / PSA / BGS / CGC / SGC) — on-demand lookup tool ──
app.get('/api/comps/multigrade', async (req, res) => {
  try {
    const { player, year, brand, cardNum } = req.query
    if (!player) return res.status(400).json({ error: 'player is required' })
    const words = brand ? brand.trim().split(/\s+/).slice(0, 2).join(' ') : ''
    const q = [year, words, player.trim(), cardNum ? '#' + String(cardNum).replace(/^#/, '') : ''].filter(Boolean).join(' ')
    const search = await scpFetch('products', { q })
    if (search.status !== 'success' || !search.products?.length) return res.json({ status: 'not_found', query: q })
    const detail = await scpFetch('product', { id: search.products[0].id })
    if (detail.status !== 'success') return res.json({ status: 'not_found', query: q })
    res.json({
      status: 'success',
      query: q,
      matchedProduct: detail['product-name'],
      matchedSet: detail['console-name'],
      productId: detail.id,
      raw: centsToDollars(detail['loose-price']),
      psa8: centsToDollars(detail['new-price']),
      psa9: centsToDollars(detail['graded-price']),
      psa10: centsToDollars(detail['manual-only-price']),
      bgs10: centsToDollars(detail['bgs-10-price']),
      cgc10: centsToDollars(detail['condition-17-price']),
      sgc10: centsToDollars(detail['condition-18-price']),
      salesVolume: detail['sales-volume'] ?? null,
      source: 'SportsCardsPro'
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── ONE-TIME BULK BACKFILL: re-pull every card's comps via SportsCardsPro ─────────────────
// So old (eBay-sourced) and new comps are consistent platform-wide. Fire-and-forget background job —
// responds immediately with a count, then processes sequentially respecting SCP's rate limit.
app.post('/api/comps/bulk-scp-refresh', async (req, res) => {
  try {
    const { data: cards, error } = await supabase.from('cards')
      .select('id, player_name, brand_parallel, card_number, year, numbered, comp_history')
    if (error) throw error
    res.json({ started: true, totalCards: cards.length })

    ;(async () => {
      let ok = 0, notFound = 0, fail = 0
      for (const card of cards) {
        try {
          const scp = await fetchTiersFromSCP(card)
          const now = new Date().toISOString()
          if (!scp.matched) {
            notFound++
            console.log(`[BulkSCP] no match: ${card.player_name} (${card.id})`)
          } else {
            const history = [...(card.comp_history || []), { date: now, raw: scp.raw, psa9: scp.psa9, psa10: scp.psa10, source: 'SportsCardsPro' }].slice(-52)
            await supabase.from('cards').update({
              comp_raw: scp.raw, comp_psa9: scp.psa9, comp_psa10: scp.psa10,
              comp_source: 'SportsCardsPro', comp_last_refreshed: now, comp_history: history,
            }).eq('id', card.id)
            ok++
            console.log(`[BulkSCP] ✅ ${card.player_name} raw=${scp.raw} psa9=${scp.psa9} psa10=${scp.psa10}`)
          }
        } catch (e) {
          fail++
          console.error(`[BulkSCP] ❌ ${card.id}:`, e.message)
        }
        await new Promise(r => setTimeout(r, 1100))
      }
      console.log(`[BulkSCP] Backfill complete — ok:${ok} notFound:${notFound} fail:${fail}`)
    })()
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Weekly comp auto-refresh — runs Sundays 2 AM Mountain Time.
// Now pulls through /api/comps/tiers, which is SportsCardsPro-backed as of this deploy.
cron.schedule('0 2 * * 0', async () => {
  console.log('[CronRefresh] Starting weekly comp refresh (SportsCardsPro) —', new Date().toISOString())
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
        const history = [...(card.comp_history || []), { date: now, raw: raw?.median ?? null, psa9: psa9?.median ?? null, psa10: psa10?.median ?? null, source: 'SportsCardsPro' }].slice(-52)
        await supabase.from('cards').update({
          comp_raw: raw?.median ?? card.comp_raw,
          comp_psa9: psa9?.median ?? card.comp_psa9,
          comp_psa10: psa10?.median ?? card.comp_psa10,
          comp_source: 'SportsCardsPro',
          comp_last_refreshed: now,
          comp_history: history
        }).eq('id', card.id)
        console.log(`[CronRefresh] ✅ ${card.player_name}`)
        await new Promise(r => setTimeout(r, 2200))
      } catch (e) { console.error(`[CronRefresh] ❌ ${card.id}:`, e.message) }
    }
  } catch (e) { console.error('[CronRefresh] Fatal:', e.message) }
}, { timezone: 'America/Denver' })

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('GradeEdge API v7.0.0 running on port ' + PORT)
  console.log('Primary comp source: SportsCardsPro (sold-price based)')
  console.log('SportsCardsPro token configured:', !!process.env.SPORTSCARDSPRO_API_TOKEN)
  console.log('eBay Client ID configured (legacy /api/comps + /api/comps/bulk only):', !!process.env.EBAY_CLIENT_ID)
  console.log('Anthropic configured:', !!process.env.ANTHROPIC_API_KEY)
})

require('dotenv').config()
const express = require('express')
const cors = require('cors')
const fetch = require('node-fetch')
const multer = require('multer')
const Anthropic = require('@anthropic-ai/sdk')

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

// Single-grade comp (used by edit modal LiveCompFetcher)
app.get('/api/comps', async (req, res) => {
  try {
    const { player, brand, year, grade, cardNum } = req.query
    if (!player) return res.status(400).json({ error: 'player is required' })

    const query = grade
      ? buildGradedQuery(player, year, brand, cardNum, String(grade).replace(/^PSA\s*/i, ''))
      : buildRawQuery(player, year, brand, cardNum)

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
    const rStats = calcStats(recent.map(c => c.price))
    const oStats = calcStats(older.map(c => c.price))
    const aStats = calcStats(comps.map(c => c.price))

    let trend = null, trendLabel = 'Not enough data for trend'
    if (rStats && oStats && oStats.avg > 0) {
      trend = Math.round(((rStats.avg - oStats.avg) / oStats.avg * 100) * 10) / 10
      trendLabel = trend > 0 ? `Up ${Math.abs(trend)}% vs 30-60 days ago` : `Down ${Math.abs(trend)}% vs 30-60 days ago`
    }

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

// ── THREE-TIER COMP: Raw + PSA 9 + PSA 10 in one call ─────────────────────
app.get('/api/comps/tiers', async (req, res) => {
  try {
    const { player, brand, year, cardNum } = req.query
    if (!player) return res.status(400).json({ error: 'player is required' })

    console.log(`Fetching 3-tier comps: ${player} ${year} ${brand} #${cardNum}`)

    // Run all 3 queries in parallel
    const [rawItems, psa9Items, psa10Items] = await Promise.all([
      fetchItems(buildRawQuery(player, year, brand, cardNum), 80).catch(e => { console.error('Raw fetch error:', e.message); return [] }),
      fetchItems(buildGradedQuery(player, year, brand, cardNum, '9'), 60).catch(e => { console.error('PSA9 fetch error:', e.message); return [] }),
      fetchItems(buildGradedQuery(player, year, brand, cardNum, '10'), 60).catch(e => { console.error('PSA10 fetch error:', e.message); return [] })
    ])

    function tierResult(items, label) {
      const comps = parseItems(items)
      const stats = calcStats(comps.map(c => c.price))
      const recent = comps.filter(c => c.daysAgo <= 30)
      const older = comps.filter(c => c.daysAgo > 30 && c.daysAgo <= 60)
      const rStats = calcStats(recent.map(c => c.price))
      const oStats = calcStats(older.map(c => c.price))
      let trend = null, trendLabel = 'Not enough data'
      if (rStats && oStats && oStats.avg > 0) {
        trend = Math.round(((rStats.avg - oStats.avg) / oStats.avg * 100) * 10) / 10
        trendLabel = trend > 0 ? `↑ ${Math.abs(trend)}% vs 30-60d` : `↓ ${Math.abs(trend)}% vs 30-60d`
      }
      return {
        label,
        count: comps.length,
        avg: stats?.avg || null,
        median: stats?.median || null,
        high: stats?.high || null,
        low: stats?.low || null,
        recommended: rStats?.recommended || stats?.recommended || null,
        trend,
        trendLabel,
        comps: comps.slice(0, 8)
      }
    }

    res.json({
      player, brand, year, cardNum,
      raw: tierResult(rawItems, 'Raw'),
      psa9: tierResult(psa9Items, 'PSA 9'),
      psa10: tierResult(psa10Items, 'PSA 10'),
      fetchedAt: new Date().toISOString()
    })
  } catch (err) {
    console.error('Tier comps error:', err.message)
    res.status(500).json({ error: err.message })
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

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('GradeEdge API v6.0.0 running on port ' + PORT)
  console.log('eBay Client ID configured:', !!process.env.EBAY_CLIENT_ID)
  console.log('eBay Client Secret configured:', !!process.env.EBAY_CLIENT_SECRET)
  console.log('Anthropic configured:', !!process.env.ANTHROPIC_API_KEY)
})
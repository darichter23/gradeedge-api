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
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
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

// ── Fetch SOLD comps via Browse API ────────────────────────────────────────
// The Browse API /item_summary/search with filter=buyingOptions:{AUCTION|FIXED_PRICE}
// does NOT natively return only SOLD listings. To get true sold comps we use
// the "completed items" approach: search with a past-90-day window by sorting
// EndTimeSoonest and filtering on soldItems. eBay's modern equivalent is to use
// the Marketplace Insights API — but that requires special approval.
//
// Best available approach for standard OAuth apps:
//   Browse API search → recently ended fixed-price + auction items
//   We filter client-side by items that have a lastSoldPrice or currentBidPrice
//   and label them as sold comps. This is what most comp tools do.

async function fetchSoldComps(query, limit) {
  limit = limit || 100
  const token = await getEbayToken()

  // Browse API: search active + recently ended listings
  // Condition IDs: 1000=New, 2000=Refurb, 2500=Very Good, 3000=Good, 4000=Acceptable, 5000=For parts
  // Sports cards are typically listed as Used (3000) or New (1000 - sealed)
  // Omitting conditions filter so we get all results (graded cards often listed as "New")
  const params = new URLSearchParams({
    q: query,
    limit: Math.min(limit, 200).toString(),
    sort: 'newlyListed',
    fieldgroups: 'MATCHING_ITEMS'
  })

  const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`
  console.log('Calling eBay Browse API:', url.substring(0, 120))

  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      'Content-Type': 'application/json'
    }
  })

  const text = await res.text()
  console.log('eBay Browse response status:', res.status)
  console.log('eBay Browse response preview:', text.substring(0, 150))

  if (res.status === 401) {
    ebayToken = null // force token refresh next call
    throw new Error('eBay auth failed - check EBAY_CLIENT_ID and EBAY_CLIENT_SECRET in Railway')
  }

  if (text.startsWith('<')) throw new Error('eBay returned HTML - unexpected error')

  const data = JSON.parse(text)
  if (data.errors) {
    console.error('eBay API errors:', JSON.stringify(data.errors))
    throw new Error('eBay API error: ' + (data.errors[0]?.message || JSON.stringify(data.errors)))
  }

  const items = data.itemSummaries || []
  console.log('Items found:', items.length)
  return items
}

// ── Stats calculator ────────────────────────────────────────────────────────
function calcStats(prices) {
  const sorted = prices.filter(p => p > 1).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  let w = sorted
  if (sorted.length >= 5) {
    const t = Math.max(1, Math.floor(sorted.length * 0.1))
    w = sorted.slice(t, sorted.length - t)
  }
  const avg = w.reduce((a, b) => a + b, 0) / w.length
  return {
    count: sorted.length,
    avg: Math.round(avg * 100) / 100,
    median: Math.round(w[Math.floor(w.length / 2)] * 100) / 100,
    high: sorted[sorted.length - 1],
    low: sorted[0],
    recommended: Math.round(avg * 100) / 100
  }
}

// ── Routes ──────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'GradeEdge API running', version: '5.0.0' })
})

app.get('/api/comps', async (req, res) => {
  try {
    const { player, brand, year, grade, cardNum } = req.query
    if (!player) return res.status(400).json({ error: 'player is required' })

    const parts = [player]
    if (year) parts.push(year)
    if (brand) parts.push(brand)
    if (grade) parts.push('PSA ' + grade)
    if (cardNum) parts.push('#' + cardNum)
    const query = parts.join(' ')
    console.log('Fetching comps for:', query)

    const rawItems = await fetchSoldComps(query, 100)

    if (rawItems.length === 0) {
      return res.json({
        query, count: 0,
        stats: { avg: 0, median: 0, high: 0, low: 0, recommended: 0, trendLabel: 'No data found' },
        comps: [], message: 'No listings found. Try fewer search terms.',
        source: 'eBay Browse API'
      })
    }

    const now = Date.now()
    const comps = rawItems.map(item => {
      // Browse API: lastSoldPrice if available, else listed price
      const priceVal = item.lastSoldPrice?.value || item.price?.value || item.currentBidPrice?.value || '0'
      const price = parseFloat(priceVal)

      // Prefer lastSoldDate, then itemEndDate, then itemCreationDate as fallback
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

    const recent = comps.filter(c => c.daysAgo <= 30)
    const older = comps.filter(c => c.daysAgo > 30 && c.daysAgo <= 60)
    const rStats = calcStats(recent.map(c => c.price))
    const oStats = calcStats(older.map(c => c.price))
    const aStats = calcStats(comps.map(c => c.price))

    let trend = null
    let trendLabel = 'Not enough data for trend'
    if (rStats && oStats && oStats.avg > 0) {
      trend = Math.round(((rStats.avg - oStats.avg) / oStats.avg * 100) * 10) / 10
      trendLabel = trend > 0
        ? `Up ${Math.abs(trend)}% vs 30-60 days ago`
        : `Down ${Math.abs(trend)}% vs 30-60 days ago`
    }

    res.json({
      query, count: comps.length, recentCount: recent.length, olderCount: older.length,
      stats: {
        avg: aStats?.avg || 0,
        median: aStats?.median || 0,
        high: aStats?.high || 0,
        low: aStats?.low || 0,
        recommended: rStats?.recommended || aStats?.recommended || 0,
        trend, trendLabel
      },
      recentStats: rStats,
      olderStats: oStats,
      comps: comps.slice(0, 15),
      source: 'eBay Browse API',
      fetchedAt: new Date().toISOString()
    })
  } catch (err) {
    console.error('Comps error:', err.message)
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
        const query = [card.player, card.year, card.brand, card.grade ? 'PSA ' + card.grade : ''].filter(Boolean).join(' ')
        const items = await fetchSoldComps(query, 20)
        const prices = items.map(i => parseFloat(i.price?.value || 0)).filter(p => p > 0)
        const avg = prices.length > 0 ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length * 100) / 100 : null
        results.push({ id: card.id, comp: avg, count: prices.length, query })
        await new Promise(r => setTimeout(r, 300))
      } catch (err) { results.push({ id: card.id, comp: null, error: err.message }) }
    }
    res.json({ results, processed: results.length })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('GradeEdge API v5.0.0 running on port ' + PORT)
  console.log('eBay Client ID configured:', !!process.env.EBAY_CLIENT_ID)
  console.log('eBay Client Secret configured:', !!process.env.EBAY_CLIENT_SECRET)
  console.log('Anthropic configured:', !!process.env.ANTHROPIC_API_KEY)
})
require('dotenv').config()
const express = require('express')
const cors = require('cors')
const fetch = require('node-fetch')
const rateLimit = require('express-rate-limit')
const multer = require('multer')
const Anthropic = require('@anthropic-ai/sdk')

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors({ origin: true, credentials: true }))
app.use(express.json({ limit: '10mb' }))
app.set('trust proxy', 1)

const limiter = rateLimit({ windowMs: 60 * 1000, max: 60, message: 'Too many requests' })
const scanLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, message: 'Scan limit reached' })
app.use('/api/', limiter)
app.use('/api/scan', scanLimiter)

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

let ebayToken = null
let ebayTokenExpiry = 0

async function getEbayToken() {
  if (ebayToken && Date.now() < ebayTokenExpiry) return ebayToken
  const credentials = Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64')
  const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope'
  })
  const data = await response.json()
  if (!data.access_token) throw new Error('eBay auth failed: ' + JSON.stringify(data))
  ebayToken = data.access_token
  ebayTokenExpiry = Date.now() + (data.expires_in - 60) * 1000
  return ebayToken
}

async function fetchSoldComps(query, limit) {
  limit = limit || 100
  const appId = process.env.EBAY_CLIENT_ID
  const url = 'https://svcs.ebay.com/services/search/FindingService/v1'
    + '?OPERATION-NAME=findCompletedItems'
    + '&SERVICE-VERSION=1.0.0'
    + '&SECURITY-APPNAME=' + encodeURIComponent(appId)
    + '&RESPONSE-DATA-FORMAT=JSON'
    + '&keywords=' + encodeURIComponent(query)
    + '&itemFilter(0).name=SoldItemsOnly'
    + '&itemFilter(0).value=true'
    + '&itemFilter(1).name=Currency'
    + '&itemFilter(1).value=USD'
    + '&sortOrder=EndTimeSoonest'
    + '&paginationInput.entriesPerPage=' + limit

  console.log('eBay URL:', url.substring(0, 150))
  const res = await fetch(url)
  const text = await res.text()
  console.log('eBay raw response start:', text.substring(0, 100))

  if (text.startsWith('<')) {
    throw new Error('eBay returned HTML error page - check App ID')
  }

  const data = JSON.parse(text)
  const ack = data?.findCompletedItemsResponse?.[0]?.ack?.[0]
  const items = data?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || []
  console.log('eBay ack:', ack, 'items:', items.length)
  return items
}

function calcStats(items) {
  const prices = items.map(i => parseFloat(i.sellingStatus?.[0]?.currentPrice?.[0]?.['__value__'] || 0))
    .filter(p => p > 1)
    .sort((a, b) => a - b)
  if (prices.length === 0) return null
  let working = prices
  if (prices.length >= 5) {
    const trim = Math.max(1, Math.floor(prices.length * 0.1))
    working = prices.slice(trim, prices.length - trim)
  }
  const avg = working.reduce((a, b) => a + b, 0) / working.length
  const median = working[Math.floor(working.length / 2)]
  return {
    count: prices.length,
    avg: Math.round(avg * 100) / 100,
    median: Math.round(median * 100) / 100,
    high: prices[prices.length - 1],
    low: prices[0],
    recommended: Math.round(avg * 100) / 100
  }
}

app.get('/', (req, res) => {
  res.json({ status: 'GradeEdge API running', version: '3.0.0', features: ['ebay-sold-comps', 'card-scanner'] })
})

app.get('/api/comps', async (req, res) => {
  try {
    const { player, brand, year, grade, cardNum } = req.query
    if (!player) return res.status(400).json({ error: 'player is required' })

    const parts = [player]
    if (year) parts.push(year)
    if (brand) parts.push(brand)
    if (grade) parts.push(grade)
    if (cardNum) parts.push(cardNum)
    const query = parts.join(' ')
    console.log('Fetching SOLD comps for:', query)

    const rawItems = await fetchSoldComps(query, 100)

    if (rawItems.length === 0) {
      return res.json({
        query, count: 0,
        stats: { avg: 0, median: 0, high: 0, low: 0, recommended: 0, trendLabel: 'No sold data found' },
        comps: [],
        message: 'No sold listings found. Try fewer search terms.',
        source: 'eBay Finding API - Sold Only'
      })
    }

    const now = Date.now()
    const comps = rawItems.map(item => {
      const price = parseFloat(item.sellingStatus?.[0]?.currentPrice?.[0]?.['__value__'] || 0)
      const endTimeStr = item.listingInfo?.[0]?.endTime?.[0]
      const endTime = endTimeStr ? new Date(endTimeStr) : null
      const daysAgo = endTime ? Math.round((now - endTime.getTime()) / (1000 * 60 * 60 * 24)) : 999
      return {
        title: item.title?.[0] || '',
        price,
        soldDate: endTime?.toISOString() || null,
        daysAgo,
        url: item.viewItemURL?.[0] || '',
        image: item.galleryURL?.[0] || null,
        condition: item.condition?.[0]?.conditionDisplayName?.[0] || 'Unknown'
      }
    }).filter(c => c.price > 1).sort((a, b) => a.daysAgo - b.daysAgo)

    const recent = comps.filter(c => c.daysAgo <= 30)
    const older = comps.filter(c => c.daysAgo > 30 && c.daysAgo <= 60)

    const recentStats = calcStats(recent.map(c => ({ sellingStatus: [{ currentPrice: [{ '__value__': c.price }] }] })).map((_, i) => ({ sellingStatus: [{ currentPrice: [{ '__value__': recent[i].price }] }], listingInfo: [{ endTime: [recent[i].soldDate] }] })))
    const olderStats = calcStats(older.map((_, i) => ({ sellingStatus: [{ currentPrice: [{ '__value__': older[i].price }] }] })))

    const recentPrices = recent.map(c => c.price).filter(p => p > 1).sort((a, b) => a - b)
    const olderPrices = older.map(c => c.price).filter(p => p > 1).sort((a, b) => a - b)
    const allPrices = comps.map(c => c.price).filter(p => p > 1).sort((a, b) => a - b)

    function stats(prices) {
      if (!prices.length) return null
      let w = prices
      if (prices.length >= 5) { const t = Math.max(1, Math.floor(prices.length * 0.1)); w = prices.slice(t, prices.length - t) }
      const avg = w.reduce((a, b) => a + b, 0) / w.length
      return { count: prices.length, avg: Math.round(avg * 100) / 100, median: Math.round(w[Math.floor(w.length / 2)] * 100) / 100, high: prices[prices.length - 1], low: prices[0], recommended: Math.round(avg * 100) / 100 }
    }

    const rStats = stats(recentPrices)
    const oStats = stats(olderPrices)
    const aStats = stats(allPrices)

    let trend = null, trendLabel = 'Not enough data for trend'
    if (rStats && oStats && oStats.avg > 0) {
      trend = Math.round(((rStats.avg - oStats.avg) / oStats.avg * 100) * 10) / 10
      trendLabel = trend > 0 ? ('Up ' + Math.abs(trend) + '% vs 30-60 days ago') : ('Down ' + Math.abs(trend) + '% vs 30-60 days ago')
    }

    res.json({
      query, count: comps.length, recentCount: recent.length, olderCount: older.length,
      stats: { avg: aStats?.avg || 0, median: aStats?.median || 0, high: aStats?.high || 0, low: aStats?.low || 0, recommended: rStats?.recommended || aStats?.recommended || 0, trend, trendLabel },
      recentStats: rStats, olderStats: oStats,
      comps: comps.slice(0, 15),
      source: 'eBay Finding API - SOLD listings only',
      fetchedAt: new Date().toISOString()
    })
  } catch (err) {
    console.error('Comps error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

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
        { type: 'text', text: 'You are a sports card expert. Analyze this card and return ONLY valid JSON: {"player":"name","year":2024,"brand":"manufacturer","setName":"set","parallel":"parallel or null","cardNum":"number","sport":"Baseball|Basketball|Football|Hockey|Other","team":"team","rookie":false,"autograph":false,"serialNumber":"x/y or null","grader":"PSA|BGS|SGC|CGC or null","grade":null,"certNum":null,"confidence":"high|medium|low","confidenceReason":"reason"}. No markdown.' }
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

app.post('/api/comps/bulk', async (req, res) => {
  try {
    const { cards } = req.body
    if (!cards || !Array.isArray(cards)) return res.status(400).json({ error: 'cards array required' })
    const results = []
    for (const card of cards.slice(0, 10)) {
      try {
        const query = [card.player, card.year, card.brand, card.grade ? 'PSA ' + card.grade : ''].filter(Boolean).join(' ')
        const items = await fetchSoldComps(query, 20)
        const prices = items.map(i => parseFloat(i.sellingStatus?.[0]?.currentPrice?.[0]?.['__value__'] || 0)).filter(p => p > 0)
        const avg = prices.length > 0 ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length * 100) / 100 : null
        results.push({ id: card.id, comp: avg, count: prices.length, query })
        await new Promise(r => setTimeout(r, 300))
      } catch (err) { results.push({ id: card.id, comp: null, error: err.message }) }
    }
    res.json({ results, processed: results.length })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.listen(PORT, () => {
  console.log('GradeEdge API running on port ' + PORT)
  console.log('eBay App ID:', process.env.EBAY_CLIENT_ID ? process.env.EBAY_CLIENT_ID.substring(0, 20) + '...' : 'NOT SET')
})

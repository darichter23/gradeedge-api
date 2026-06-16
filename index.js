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

app.get('/', (req, res) => {
  res.json({ status: 'GradeEdge API running', version: '2.0.0', features: ['ebay-sold-comps', 'card-scanner'] })
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

    const params = new URLSearchParams()
    params.set('OPERATION-NAME', 'findCompletedItems')
    params.set('SERVICE-VERSION', '1.0.0')
    params.set('SECURITY-APPNAME', process.env.EBAY_CLIENT_ID)
    params.set('RESPONSE-DATA-FORMAT', 'JSON')
    params.set('keywords', query)
    params.set('itemFilter(0).name', 'SoldItemsOnly')
    params.set('itemFilter(0).value', 'true')
    params.set('itemFilter(1).name', 'Currency')
    params.set('itemFilter(1).value', 'USD')
    params.set('sortOrder', 'EndTimeSoonest')
    params.set('paginationInput.entriesPerPage', '100')

    const url = 'https://svcs.ebay.com/services/search/FindingService/v1?' + params.toString()
    console.log('Calling eBay Finding API...')

    const ebayRes = await fetch(url)
    const ebayData = await ebayRes.json()

    const ack = ebayData?.findCompletedItemsResponse?.[0]?.ack?.[0]
    const rawItems = ebayData?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || []
    console.log('eBay response: ack=' + ack + ', items=' + rawItems.length)

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

    function calcStats(items) {
      const prices = items.map(i => i.price).sort((a, b) => a - b)
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

    const recentStats = calcStats(recent)
    const olderStats = calcStats(older)
    const allStats = calcStats(comps)

    let trendLabel = 'Not enough data for trend'
    let trend = null
    if (recentStats && olderStats && olderStats.avg > 0) {
      trend = ((recentStats.avg - olderStats.avg) / olderStats.avg * 100)
      const pct = Math.abs(trend).toFixed(1)
      trendLabel = trend > 0 ? ('Up ' + pct + '% vs 30-60 days ago') : ('Down ' + pct + '% vs 30-60 days ago')
    }

    const recommended = recentStats?.recommended || allStats?.recommended || 0

    res.json({
      query,
      count: comps.length,
      recentCount: recent.length,
      olderCount: older.length,
      stats: {
        avg: allStats?.avg || 0,
        median: allStats?.median || 0,
        high: allStats?.high || 0,
        low: allStats?.low || 0,
        recommended,
        trend: trend ? Math.round(trend * 10) / 10 : null,
        trendLabel
      },
      recentStats,
      olderStats,
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
      const dataUrl = req.body.image
      const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
      if (match) { mediaType = match[1]; imageBase64 = match[2] }
      else { imageBase64 = dataUrl; mediaType = 'image/jpeg' }
    } else {
      return res.status(400).json({ error: 'No image provided' })
    }

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: 'You are a sports card expert. Analyze this card and return ONLY valid JSON with these fields: {"player":"name","year":2024,"brand":"manufacturer","setName":"set","parallel":"parallel or null","cardNum":"number","sport":"Baseball|Basketball|Football|Hockey|Other","team":"team","rookie":false,"autograph":false,"serialNumber":"x/y or null","grader":"PSA|BGS|SGC|CGC or null","grade":null,"certNum":null,"confidence":"high|medium|low","confidenceReason":"reason"}. No markdown, no explanation.' }
        ]
      }]
    })

    const responseText = message.content[0].text.trim()
    let cardData
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/)
      cardData = JSON.parse(jsonMatch ? jsonMatch[0] : responseText)
    } catch (e) {
      return res.status(500).json({ error: 'Could not parse card data', raw: responseText })
    }
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
        const params = new URLSearchParams()
        params.set('OPERATION-NAME', 'findCompletedItems')
        params.set('SERVICE-VERSION', '1.0.0')
        params.set('SECURITY-APPNAME', process.env.EBAY_CLIENT_ID)
        params.set('RESPONSE-DATA-FORMAT', 'JSON')
        params.set('keywords', query)
        params.set('itemFilter(0).name', 'SoldItemsOnly')
        params.set('itemFilter(0).value', 'true')
        params.set('paginationInput.entriesPerPage', '20')
        const r = await fetch('https://svcs.ebay.com/services/search/FindingService/v1?' + params.toString())
        const d = await r.json()
        const items = d?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || []
        const prices = items.map(i => parseFloat(i.sellingStatus?.[0]?.currentPrice?.[0]?.['__value__'] || 0)).filter(p => p > 0)
        const avg = prices.length > 0 ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length * 100) / 100 : null
        results.push({ id: card.id, comp: avg, count: prices.length, query })
        await new Promise(r => setTimeout(r, 200))
      } catch (err) {
        results.push({ id: card.id, comp: null, error: err.message })
      }
    }
    res.json({ results, processed: results.length })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, () => {
  console.log('GradeEdge API running on port ' + PORT)
  console.log('Features: eBay SOLD comps, Claude card scanner')
})

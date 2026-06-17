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

  console.log('Calling eBay:', url.substring(0, 120))
  const res = await fetch(url)
  const text = await res.text()
  console.log('eBay response preview:', text.substring(0, 80))
  if (text.startsWith('<')) throw new Error('eBay returned HTML - check App ID in Railway variables')
  const data = JSON.parse(text)
  const items = data?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || []
  console.log('Sold items found:', items.length)
  return items
}

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

app.get('/', (req, res) => {
  res.json({ status: 'GradeEdge API running', version: '4.0.0' })
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
        comps: [], message: 'No sold listings found. Try fewer search terms.',
        source: 'eBay Finding API - Sold Only'
      })
    }

    const now = Date.now()
    const comps = rawItems.map(item => {
      const price = parseFloat(item.sellingStatus?.[0]?.currentPrice?.[0]?.['__value__'] || 0)
      const endTimeStr = item.listingInfo?.[0]?.endTime?.[0]
      const endTime = endTimeStr ? new Date(endTimeStr) : null
      const daysAgo = endTime ? Math.round((now - endTime.getTime()) / (1000 * 60 * 60 * 24)) : 999
      return { title: item.title?.[0] || '', price, soldDate: endTime?.toISOString() || null, daysAgo, url: item.viewItemURL?.[0] || '', image: item.galleryURL?.[0] || null, condition: item.condition?.[0]?.conditionDisplayName?.[0] || 'Unknown' }
    }).filter(c => c.price > 1).sort((a, b) => a.daysAgo - b.daysAgo)

    const recent = comps.filter(c => c.daysAgo <= 30)
    const older = comps.filter(c => c.daysAgo > 30 && c.daysAgo <= 60)
    const rStats = calcStats(recent.map(c => c.price))
    const oStats = calcStats(older.map(c => c.price))
    const aStats = calcStats(comps.map(c => c.price))

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
  console.log('GradeEdge API v4.0.0 running on port ' + PORT)
  console.log('eBay App ID configured:', !!process.env.EBAY_CLIENT_ID)
  console.log('Anthropic configured:', !!process.env.ANTHROPIC_API_KEY)
})

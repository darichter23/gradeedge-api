/**
 * GradeEdge Pro — Backend API Server
 * Handles: eBay live comps, Claude AI card scanner, photo storage proxy
 * Deploy to: Railway.app
 * Domain: api.boisesummitcards.com
 */

require('dotenv').config()
const express = require('express')
const cors = require('cors')
const fetch = require('node-fetch')
const rateLimit = require('express-rate-limit')
const multer = require('multer')
const Anthropic = require('@anthropic-ai/sdk')

const app = express()
const PORT = process.env.PORT || 3001  // Railway sets PORT automatically

// ── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: true, // Allow all origins - restrict later for production
  credentials: true
}))
app.use(express.json({ limit: '10mb' }))

// Rate limiting — prevent abuse
const limiter = rateLimit({ windowMs: 60 * 1000, max: 60, message: 'Too many requests' })
const scanLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, message: 'Scan limit reached' })
app.use('/api/', limiter)
app.use('/api/scan', scanLimiter)

// Multer for photo uploads (memory storage, passed to Claude)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

// ── CLIENTS ──────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── EBAY TOKEN CACHE ─────────────────────────────────────────────────────────
let ebayToken = null
let ebayTokenExpiry = 0

async function getEbayToken() {
  if (ebayToken && Date.now() < ebayTokenExpiry) return ebayToken
  const credentials = Buffer.from(
    `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
  ).toString('base64')
  const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope'
  })
  const data = await response.json()
  if (!data.access_token) throw new Error('eBay auth failed: ' + JSON.stringify(data))
  ebayToken = data.access_token
  ebayTokenExpiry = Date.now() + (data.expires_in - 60) * 1000
  return ebayToken
}

// ── ROUTE: Health check ───────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ 
    status: 'GradeEdge API running',
    version: '1.0.0',
    features: ['ebay-comps', 'card-scanner', 'photo-storage']
  })
})

// ── ROUTE: eBay sold comps ────────────────────────────────────────────────────
// GET /api/comps?player=Shohei Ohtani&brand=Topps Chrome&year=2024&grade=PSA 10
app.get('/api/comps', async (req, res) => {
  try {
    const { player, brand, year, grade, cardNum } = req.query
    if (!player) return res.status(400).json({ error: 'player is required' })

    // Build eBay search query — PSA graded card
    const parts = [player]
    if (year) parts.push(year)
    if (brand) parts.push(brand)
    if (grade) parts.push(grade)
    if (cardNum) parts.push(`#${cardNum}`)
    const query = parts.join(' ')

    // Use eBay Marketplace Insights API for SOLD listings
    // This is the correct modern eBay API for sold/completed item data
    const token = await getEbayToken()
    
    const insightsUrl = new URL('https://api.ebay.com/buy/marketplace_insights/v1_beta/item_sales/search')
    insightsUrl.searchParams.set('q', query)
    insightsUrl.searchParams.set('limit', '50')
    insightsUrl.searchParams.set('fieldgroups', 'ADDITIONAL_SELLER_DETAILS')

    const insightsRes = await fetch(insightsUrl.toString(), {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        'Content-Type': 'application/json'
      }
    })

    console.log('Insights API status:', insightsRes.status)
    const insightsData = await insightsRes.json()
    console.log('Insights API response keys:', Object.keys(insightsData))
    
    let rawItems = []
    
    if (insightsRes.ok && insightsData.itemSales && insightsData.itemSales.length > 0) {
      // Parse marketplace insights sold items
      rawItems = insightsData.itemSales.map(item => ({
        title: item.title,
        price: parseFloat(item.lastSoldPrice?.value || 0),
        soldDate: item.lastSoldDate || null,
        daysAgo: item.lastSoldDate ? Math.round((Date.now() - new Date(item.lastSoldDate).getTime()) / (1000*60*60*24)) : null,
        url: item.itemWebUrl || '',
        image: item.image?.imageUrl || null,
        condition: item.condition || 'Unknown',
        listingType: 'Sold'
      })).filter(c => c.price > 0)
    } else {
      // Fallback: Use Finding API (legacy but still works)
      console.log('Insights API failed, trying Finding API fallback')
      const findingUrl = `https://svcs.ebay.com/services/search/FindingService/v1?OPERATION-NAME=findCompletedItems&SERVICE-VERSION=1.0.0&SECURITY-APPNAME=${encodeURIComponent(process.env.EBAY_CLIENT_ID)}&RESPONSE-DATA-FORMAT=JSON&keywords=${encodeURIComponent(query)}&itemFilter%280%29.name=SoldItemsOnly&itemFilter%280%29.value=true&itemFilter%281%29.name=Currency&itemFilter%281%29.value=USD&sortOrder=EndTimeSoonest&paginationInput.entriesPerPage=50`
      
      const findingRes = await fetch(findingUrl)
      const findingData = await findingRes.json()
      const findingItems = findingData?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || []
      
      rawItems = findingItems.map(item => {
        const price = parseFloat(item.sellingStatus?.[0]?.currentPrice?.[0]?.['__value__'] || 0)
        const endTime = item.listingInfo?.[0]?.endTime?.[0]
        const soldDate = endTime ? new Date(endTime) : null
        return {
          title: item.title?.[0] || '',
          price,
          soldDate: soldDate?.toISOString() || null,
          daysAgo: soldDate ? Math.round((Date.now() - soldDate.getTime()) / (1000*60*60*24)) : null,
          url: item.viewItemURL?.[0] || '',
          image: item.galleryURL?.[0] || null,
          condition: item.condition?.[0]?.conditionDisplayName?.[0] || 'Unknown',
          listingType: item.listingInfo?.[0]?.listingType?.[0] || 'Unknown'
        }
      }).filter(c => c.price > 0)
    }

    if (rawItems.length === 0) {
      // Fallback to Browse API if Finding API returns nothing
      console.log('Finding API returned 0 results, trying Browse API fallback')
      const searchUrl = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search')
      searchUrl.searchParams.set('q', query)
      searchUrl.searchParams.set('filter', 'conditions:{USED|LIKE_NEW},priceCurrency:USD')
      searchUrl.searchParams.set('limit', '20')
      const browseRes = await fetch(searchUrl.toString(), {
        headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' }
      })
      const browseData = await browseRes.json()
      const browseItems = browseData.itemSummaries || []
      const browsePrices = browseItems.map(i => parseFloat(i.price?.value)).filter(p => p > 0)
      const browseAvg = browsePrices.length > 0 ? browsePrices.reduce((a,b)=>a+b,0)/browsePrices.length : 0
      const browseSorted = [...browsePrices].sort((a,b)=>a-b)
      const browseMedian = browseSorted.length > 0 ? browseSorted[Math.floor(browseSorted.length/2)] : 0
      return res.json({
        query, count: browseItems.length,
        stats: { avg: Math.round(browseAvg*100)/100, median: Math.round(browseMedian*100)/100, high: Math.max(...browsePrices)||0, low: Math.min(...browsePrices)||0, recommended: Math.round(browseMedian*100)/100 },
        comps: browseItems.slice(0,10).map(i=>({ title:i.title, price:parseFloat(i.price?.value), url:i.itemWebUrl, image:i.thumbnailImages?.[0]?.imageUrl, note:'Active listing — sold data unavailable for this query' })),
        source: 'eBay Browse API (active listings - no sold data found)',
        warning: 'Could not find sold listings for this query. Prices shown are active listings.',
        fetchedAt: new Date().toISOString()
      })
    }

    // Parse Finding API sold items
    const now = Date.now()
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000)

    const comps = rawItems.map(item => {
      const price = parseFloat(item.sellingStatus?.[0]?.currentPrice?.[0]?.['__value__'] || 0)
      const endTime = item.listingInfo?.[0]?.endTime?.[0]
      const soldDate = endTime ? new Date(endTime) : null
      return {
        title: item.title?.[0] || '',
        price,
        soldDate: soldDate?.toISOString() || null,
        daysAgo: soldDate ? Math.round((now - soldDate.getTime()) / (1000*60*60*24)) : null,
        url: item.viewItemURL?.[0] || '',
        image: item.galleryURL?.[0] || null,
        condition: item.condition?.[0]?.conditionDisplayName?.[0] || 'Unknown',
        bids: parseInt(item.sellingStatus?.[0]?.bidCount?.[0] || 0),
        listingType: item.listingInfo?.[0]?.listingType?.[0] || 'Unknown'
      }
    }).filter(c => c.price > 0).sort((a, b) => new Date(b.soldDate) - new Date(a.soldDate))

    // Split into recent (0-30 days) and older (30-60 days)
    const recent = comps.filter(c => c.daysAgo !== null && c.daysAgo <= 30)
    const older = comps.filter(c => c.daysAgo !== null && c.daysAgo > 30 && c.daysAgo <= 60)
    const allSold = comps

    // Calculate stats - use median to avoid outlier skew
    function calcStats(items) {
      const prices = items.map(i => i.price).filter(p => p > 0).sort((a,b) => a-b)
      if (prices.length === 0) return null
      const avg = prices.reduce((a,b)=>a+b,0) / prices.length
      const median = prices[Math.floor(prices.length/2)]
      // Trim outliers: remove top and bottom 10% for trimmed mean
      const trim = Math.floor(prices.length * 0.1)
      const trimmed = prices.slice(trim, prices.length - trim)
      const trimmedAvg = trimmed.length > 0 ? trimmed.reduce((a,b)=>a+b,0)/trimmed.length : avg
      return {
        count: prices.length,
        avg: Math.round(avg * 100) / 100,
        median: Math.round(median * 100) / 100,
        trimmedAvg: Math.round(trimmedAvg * 100) / 100,
        high: prices[prices.length - 1],
        low: prices[0],
        recommended: Math.round(trimmedAvg * 100) / 100
      }
    }

    const recentStats = calcStats(recent)
    const olderStats = calcStats(older)
    const allStats = calcStats(allSold)

    // Best recommended price: prioritize recent sales trimmed average
    const recommended = recentStats?.recommended || allStats?.recommended || 0
    // 30-day trend
    const trend = recentStats && olderStats 
      ? ((recentStats.recommended - olderStats.recommended) / olderStats.recommended * 100).toFixed(1)
      : null

    res.json({
      query,
      count: allSold.length,
      recentCount: recent.length,
      stats: {
        ...allStats,
        recommended,
        trend: trend ? parseFloat(trend) : null,
        trendLabel: trend ? (parseFloat(trend) > 0 ? `↑ ${trend}% vs 30d ago` : `↓ ${Math.abs(trend)}% vs 30d ago`) : null
      },
      recentStats,
      olderStats,
      comps: allSold.slice(0, 15),
      source: 'eBay Finding API — Sold/Completed Listings Only',
      fetchedAt: new Date().toISOString()
    })

  } catch (err) {
    console.error('eBay comps error:', err)
    res.status(500).json({ error: err.message, detail: 'eBay API error' })
  }
})

// ── ROUTE: AI Card Scanner ────────────────────────────────────────────────────
// POST /api/scan — multipart form with image file OR base64 in JSON
app.post('/api/scan', upload.single('image'), async (req, res) => {
  console.log('Scan request received')
  try {
    let imageBase64, mediaType
    console.log('Has file:', !!req.file, 'Has body image:', !!(req.body && req.body.image))
    if (req.file) {
      // Uploaded file via multipart
      imageBase64 = req.file.buffer.toString('base64')
      mediaType = req.file.mimetype || 'image/jpeg'
    } else if (req.body.image) {
      // Base64 sent directly in JSON body
      const dataUrl = req.body.image
      const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
      if (match) {
        mediaType = match[1]
        imageBase64 = match[2]
      } else {
        imageBase64 = dataUrl
        mediaType = 'image/jpeg'
      }
    } else {
      return res.status(400).json({ error: 'No image provided. Send as multipart file or base64 in body.image' })
    }

    // Send to Claude Vision
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: imageBase64 }
          },
          {
            type: 'text',
            text: `You are a world-class sports card expert. Analyze this card image carefully and extract ALL visible text and details.

Look for: player name, year, brand/manufacturer (Topps, Panini, Bowman, etc.), set name, parallel/variation (Chrome, Prizm, Refractor, Gold, etc.), card number, sport, team, rookie indicator, autograph, serial number, and if graded: the grade and cert number from the label.

Return ONLY valid JSON:
{
  "player": "exact full name",
  "year": 2024,
  "brand": "manufacturer",
  "setName": "set name e.g. Topps Chrome",
  "parallel": "parallel name or null",
  "cardNum": "card number",
  "sport": "Baseball|Basketball|Football|Hockey|Soccer|Pokemon TCG|Other",
  "team": "team name",
  "rookie": false,
  "autograph": false,
  "serialNumber": "x/y or null",
  "grader": "PSA|BGS|SGC|CGC or null",
  "grade": null,
  "certNum": null,
  "searchQuery": "best eBay search query e.g. 2024 Topps Chrome Shohei Ohtani PSA 10",
  "confidence": "high|medium|low",
  "confidenceReason": "brief reason"
}

Return ONLY valid JSON. No markdown, no explanation.`
          }
        ]
      }]
    })

    const responseText = message.content[0].text.trim()
    
    // Parse JSON response
    let cardData
    try {
      // Handle cases where Claude might wrap in markdown
      const jsonMatch = responseText.match(/\{[\s\S]*\}/)
      cardData = JSON.parse(jsonMatch ? jsonMatch[0] : responseText)
    } catch (parseErr) {
      return res.status(500).json({ 
        error: 'Could not parse card data', 
        raw: responseText 
      })
    }

    res.json({
      success: true,
      card: cardData,
      scannedAt: new Date().toISOString()
    })

  } catch (err) {
    console.error('Card scan error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ── ROUTE: Bulk comp refresh for a user's cards ───────────────────────────────
// POST /api/comps/bulk — { cards: [{id, player, brand, year, grade}] }
app.post('/api/comps/bulk', async (req, res) => {
  try {
    const { cards } = req.body
    if (!cards || !Array.isArray(cards)) {
      return res.status(400).json({ error: 'cards array required' })
    }

    // Process max 10 cards at a time to avoid rate limits
    const toProcess = cards.slice(0, 10)
    const results = []

    for (const card of toProcess) {
      try {
        const parts = [card.player]
        if (card.year) parts.push(card.year)
        if (card.brand) parts.push(card.brand)
        if (card.grade) parts.push(`PSA ${card.grade}`)
        const query = parts.join(' ')

        const token = await getEbayToken()
        // Use Finding API for sold listings (bulk)
        const findingUrl = `https://svcs.ebay.com/services/search/FindingService/v1?OPERATION-NAME=findCompletedItems&SERVICE-VERSION=1.0.0&SECURITY-APPNAME=${encodeURIComponent(process.env.EBAY_CLIENT_ID)}&RESPONSE-DATA-FORMAT=JSON&keywords=${encodeURIComponent(query)}&itemFilter%280%29.name=SoldItemsOnly&itemFilter%280%29.value=true&sortOrder=EndTimeSoonest&paginationInput.entriesPerPage=20`
        const searchRes = await fetch(findingUrl)
        const data = await searchRes.json()
        const items = data?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || []
        const prices = items.map(i => parseFloat(i.sellingStatus?.[0]?.currentPrice?.[0]?.['__value__'] || 0)).filter(p => p > 0)
        const avg = prices.length > 0 ? prices.reduce((a,b)=>a+b,0)/prices.length : null

        results.push({
          id: card.id,
          comp: avg ? Math.round(avg * 100) / 100 : null,
          count: prices.length,
          query
        })

        // Small delay to be nice to eBay API
        await new Promise(r => setTimeout(r, 200))
      } catch (err) {
        results.push({ id: card.id, comp: null, error: err.message })
      }
    }

    res.json({ results, processed: toProcess.length, total: cards.length })

  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── ROUTE: Market signal for a card ──────────────────────────────────────────
// GET /api/signal?player=...&sport=...&comp=...&allIn=...
app.get('/api/signal', async (req, res) => {
  try {
    const { player, sport, comp, allIn, comp30d } = req.query
    
    const compNum = parseFloat(comp) || 0
    const allInNum = parseFloat(allIn) || 0
    const comp30dNum = parseFloat(comp30d) || 0
    
    const margin = allInNum > 0 ? (compNum - allInNum) / allInNum : 0
    const trend = comp30dNum > 0 ? (compNum - comp30dNum) / comp30dNum : 0
    
    // Sport season check
    const month = new Date().getMonth()
    const seasonMap = {
      'Baseball': [2,3,4,5,6,7,8],
      'Basketball': [0,1,2,3,4,5],
      'Football': [7,8,9,10,11,0],
      'Hockey': [0,1,2,3,4,5]
    }
    const inSeason = (seasonMap[sport] || [0,1,2,3,4,5,6,7,8,9,10,11]).includes(month)
    
    let signal, advice, action
    if (trend >= 0.1 && inSeason && margin > 0.3) {
      signal = 'STRONG_SELL'; action = '🟢 List Now'
      advice = `Comp up ${(trend*100).toFixed(0)}% — peak ${sport} season — ${(margin*100).toFixed(0)}% margin. Best window to sell.`
    } else if (trend >= 0.05 || (inSeason && margin > 0.2)) {
      signal = 'SELL'; action = '🟢 Good Time to List'
      advice = `${trend>=0.05?`Comp trending up ${(trend*100).toFixed(0)}%. `:''}${inSeason?`Peak ${sport} season. `:''}Consider listing.`
    } else if (trend <= -0.1) {
      signal = 'HOLD'; action = '🔴 Hold — Market Soft'
      advice = `Comp down ${(Math.abs(trend)*100).toFixed(0)}% from 30d ago. Wait 2-4 weeks.`
    } else if (trend <= -0.05) {
      signal = 'WATCH'; action = '🔴 Monitor Weekly'
      advice = `Comp declining. Check again in 1-2 weeks.`
    } else {
      signal = 'NEUTRAL'; action = '🟡 Hold and Watch'
      advice = `Comp flat. ${inSeason?'In season — could move up.':'Off-season — be patient.'}`
    }
    
    res.json({ signal, action, advice, margin, trend, inSeason, sport })

  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── START SERVER ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`GradeEdge API running on port ${PORT}`)
  console.log(`API URL: https://gradeedge-api-production.up.railway.app`)
  console.log(`Health check: GET /`)
  console.log(`Features: eBay comps, Claude card scanner, market signals`)
})
require('./instrument.js')
const Sentry = require('@sentry/node')
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

// Best-effort extraction of a player name from an SCP product title. SCP's console-name field
// already carries the year/brand/set (e.g. "2024 Panini Prizm"), so product-name is typically just
// the player plus a card number and/or bracketed parallel — strip those and what's left is the name.
function extractPlayerNameFromProduct(productName) {
  if (!productName) return ''
  return productName
    .replace(/#\S+/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// Look up a single card's full multi-grade comp set from SportsCardsPro.
// Two sequential API calls (search then detail) — internally paced to respect SCP's 1 req/sec limit.
async function fetchTiersFromSCP(card) {
  const brandFull = card.brand_parallel ? String(card.brand_parallel).trim().replace(/\s+/g, ' ') : ''
  const playerName = card.player_name || ''
  const yearStr = card.year || ''
  const cardNumStr = card.card_number ? '#' + String(card.card_number).replace(/^#/, '') : ''
  const lastName = playerName.trim().split(/\s+/).pop() || ''

  // Try progressively broader queries so an unusual brand/parallel wording or a card-number
  // format mismatch doesn't zero out comps that genuinely exist on SportsCardsPro.
  const attemptParts = [
    [yearStr, brandFull, playerName, cardNumStr],
    [yearStr, brandFull, playerName],
    [yearStr, playerName],
  ]

  const seen = new Set()
  let lastQuery = ''
  for (const parts of attemptParts) {
    const q = parts.filter(Boolean).join(' ').trim()
    if (!q || seen.has(q)) continue
    seen.add(q)
    lastQuery = q

    const search = await scpFetch('products', { q })
    if (search.status === 'success' && search.products?.length) {
      // Guard against SCP's search returning an unrelated player's card for a shared insert
      // set/card-number — require the player's last name to actually appear in the product.
      const nameMatches = lastName
        ? search.products.filter(p => String(p['product-name'] || '').toLowerCase().includes(lastName.toLowerCase()))
        : search.products
      const pool = nameMatches.length ? nameMatches : (lastName ? [] : search.products)

      if (pool.length) {
let best = pool[0]
const isParallelProduct = name => /\[[^\]]+\]/.test(String(name || ''))
const brandLower = brandFull.toLowerCase()
const withMatchingParallel = pool.filter(p => {
const m = String(p['product-name'] || '').match(/\[([^\]]+)\]/)
return m && brandLower.includes(m[1].toLowerCase())
})
if (withMatchingParallel.length) {
best = withMatchingParallel[0]
} else {
const base = pool.filter(p => !isParallelProduct(p['product-name']))
if (base.length) best = base[0]
}
if (cardNumStr) {
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
const num = norm(cardNumStr)
const noParallelPool = pool.filter(p => !isParallelProduct(p['product-name']))
const candidatePool = withMatchingParallel.length ? withMatchingParallel : (noParallelPool.length ? noParallelPool : pool)
const withNum = candidatePool.find(p => norm(p['product-name'] || '').includes(num))
if (withNum) best = withNum
}

await new Promise(r => setTimeout(r, 1100)) // respect SCP rate limit between the two calls

        const detail = await scpFetch('product', { id: best.id })
        if (detail.status === 'success') {
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
      }
    }

    await new Promise(r => setTimeout(r, 1100)) // pace next attempt within SCP rate limit
  }

  return { matched: false, query: lastQuery }
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

// Which comp tier represents "today's" value for the Sell/Watch/Hold signal, based on the card's
// current grading state. SCP only gives us raw/PSA9/PSA10 as clean tiers, so grades other than
// exactly 9 or 10 are anchored to the nearest of those rather than exactly matched.
function tierKeyForCard(card) {
  const grade = card.grade != null ? Number(card.grade) : null
  if (grade == null) return 'raw'
  if (grade >= 10) return 'psa10'
  if (grade >= 9) return 'psa9'
  return 'raw'
}
function pickTodayComp(scp, tierKey) {
  if (!scp.matched) return null
  return scp[tierKey] ?? null
}

// Find the comp value closest to 30 days ago in a card's stored history, for the given tier key.
// Falls back to the oldest available snapshot while history is still thinner than 30 days.
function find30dAgoValue(history, tierKey) {
  if (!Array.isArray(history) || !history.length) return null
  const targetMs = Date.now() - 30 * 24 * 60 * 60 * 1000
  let best = null, bestDiff = Infinity
  for (const h of history) {
    if (h[tierKey] == null || !h.date) continue
    const diff = Math.abs(new Date(h.date).getTime() - targetMs)
    if (diff < bestDiff) { bestDiff = diff; best = h[tierKey] }
  }
  return best
}

// ── Sell / Watch / Hold signal engine ───────────────────────────────────────
// Design goal (per owner): fire GREEN only when there's real, confirmed upward momentum AND
// the card would net a genuinely profitable sale after marketplace fees/shipping — not just
// "price ticked up." Fire RED when trending down or when selling today would net a loss.
// Everything else (including "not enough data yet") is YELLOW/GRAY so the signal never guesses.
//
// Timeframes are anchored to the weekly comp-refresh cadence (Sundays 2 AM Mountain), since that's
// the finest granularity the data supports:
//   short window  = most recent ~2 weekly snapshots + today  (~7–14 days)  → catches active momentum/spikes
//   medium window = the 4 snapshots before that                (~30–45 days) → baseline to compare against
// A card needs at least 3 weekly snapshots of real price history before the signal will commit to
// green or red — before that it shows gray ("gathering data") rather than reacting to a single noisy point.
const SIGNAL_FEE_RATE = 0.135   // ~eBay final value fee + payment processing, as a fraction of sale price
const SIGNAL_SHIP_EST = 5       // flat estimated shipping/supplies cost per card, dollars
const SIGNAL_MOMENTUM_UP = 8    // % above baseline to count as "trending up"
const SIGNAL_MOMENTUM_DOWN = -8 // % below baseline to count as "trending down"
const SIGNAL_MIN_MARGIN = 15    // minimum net margin % required to call it GREEN

// —— Event calendar for sell-timing signal ——————————————————————
// Verified dates as of Aug 2026; approximate:true entries are typical seasonal
// timing (not yet officially confirmed) and should be updated once announced.
// Keep this in sync with EVENT_CALENDAR in gradeedge-app/src/App.jsx.
const EVENT_CALENDAR = [
  { sport: 'Pokemon TCG', name: 'Pokémon World Championships (San Francisco)', date: '2026-08-28' },
  { sport: 'Football', name: 'NFL 2026 Season Kickoff', date: '2026-09-09' },
  { sport: 'Baseball', name: 'MLB Wild Card Round', date: '2026-09-29' },
  { sport: 'Hockey', name: '2026-27 NHL Season Start', date: '2026-09-29' },
  { sport: 'Baseball', name: 'MLB Division Series', date: '2026-10-03' },
  { sport: 'Basketball', name: '2026-27 NBA Opening Night', date: '2026-10-20' },
  { sport: 'Baseball', name: 'MLB World Series (Game 1)', date: '2026-10-23' },
  { sport: 'Football', name: 'Super Bowl LXI', date: '2027-02-14' },
  { sport: 'Basketball', name: 'NBA All-Star Weekend (Phoenix)', date: '2027-02-19' },
  { sport: 'Baseball', name: 'MLB Opening Day (typical timing)', date: '2027-03-26', approximate: true },
  { sport: 'Basketball', name: 'NBA Playoffs (typical start)', date: '2027-04-18', approximate: true },
  { sport: 'Hockey', name: 'NHL Playoffs (typical start)', date: '2027-04-18', approximate: true },
  { sport: 'Football', name: 'NFL Draft (typical timing)', date: '2027-04-22', approximate: true },

  { sport: 'Basketball', name: 'NBA Finals 2027 (typical timing)', date: '2027-06-10', approximate: true },
  { sport: 'Hockey', name: 'Stanley Cup Final 2027 (typical timing)', date: '2027-06-10', approximate: true },
  { sport: 'Baseball', name: 'MLB All-Star Game 2027 (typical timing)', date: '2027-07-13', approximate: true },
  { sport: 'Pokemon TCG', name: 'Pokémon World Championships 2027 (typical timing)', date: '2027-08-15', approximate: true },
  { sport: 'Football', name: 'NFL 2027 Season Kickoff (typical timing)', date: '2027-09-08', approximate: true },
  { sport: 'Hockey', name: '2027-28 NHL Season Start (typical timing)', date: '2027-10-05', approximate: true },
  { sport: 'Basketball', name: '2027-28 NBA Opening Night (typical timing)', date: '2027-10-19', approximate: true },
  { sport: 'Baseball', name: 'MLB World Series 2027 (Game 1, typical timing)', date: '2027-10-22', approximate: true },
  { sport: 'Football', name: 'Super Bowl LXII (typical timing)', date: '2028-02-13', approximate: true },
  { sport: 'Basketball', name: 'NBA All-Star Weekend 2028 (typical timing)', date: '2028-02-18', approximate: true },
  { sport: 'Baseball', name: 'MLB Opening Day 2028 (typical timing)', date: '2028-03-30', approximate: true },
]
const EVENT_WINDOW_DAYS = 21 // an event within this many days counts as "imminent" for the sell signal

// Returns the soonest upcoming event for a sport (or null), with daysUntil computed from now.
function nextEventForSport(sport) {
  if (!sport) return null
  const now = Date.now()
  const upcoming = EVENT_CALENDAR
    .filter(e => e.sport === sport)
    .map(e => ({ ...e, daysUntil: Math.ceil((new Date(e.date + 'T00:00:00Z').getTime() - now) / 86400000) }))
    .filter(e => e.daysUntil >= 0)
    .sort((a, b) => a.daysUntil - b.daysUntil)
  return upcoming[0] || null
}

const ELITE_PLAYERS = [
  'michael jordan', 'kobe bryant', 'lebron james', 'magic johnson', 'larry bird', 'wilt chamberlain', 'kareem abdul-jabbar', 'shaquille o\'neal', 'tim duncan', 'stephen curry',
  'tom brady', 'patrick mahomes', 'jerry rice', 'peyton manning', 'joe montana', 'joe burrow',
  'shohei ohtani', 'babe ruth', 'mickey mantle', 'derek jeter', 'ken griffey jr', 'mike trout', 'barry bonds', 'hank aaron', 'willie mays', 'juan soto',
  'wayne gretzky', 'sidney crosby', 'connor mcdavid'
]
function isElitePlayer(name) {
  if (!name) return false
  const n = String(name).toLowerCase()
  return ELITE_PLAYERS.some(p => n.includes(p))
}

const SIGNAL_NEAR_PEAK_PCT = 5  // today's price within this % of its tracked high counts as "at the real peak window"
const SIGNAL_OFF_PEAK_PCT = 20  // today's price this far below its tracked high, combined with falling momentum, confirms the peak has passed

function computeSellSignal(card) {
  const history = Array.isArray(card.comp_history) ? card.comp_history : []
  const tierKey = tierKeyForCard(card)
  const withVals = history.filter(h => h[tierKey] != null).map(h => Number(h[tierKey]))
  const todayVal = card.comp_today != null ? Number(card.comp_today) : (withVals.length ? withVals[withVals.length - 1] : null)

  if (withVals.length < 3 || todayVal == null) {
    return { color: 'gray', momentum_pct: null, net_margin_pct: null, reason: 'Gathering price history — need 3+ weekly comp pulls before this signal is reliable' }
  }

  const recentPoints = [...withVals.slice(-2), todayVal]
  const shortAvg = recentPoints.reduce((a, b) => a + b, 0) / recentPoints.length
  const priorPoints = withVals.slice(-6, -2)
  const baselinePoints = priorPoints.length ? priorPoints : withVals.slice(0, -2)
  const mediumAvg = baselinePoints.length ? baselinePoints.reduce((a, b) => a + b, 0) / baselinePoints.length : shortAvg
  const momentumPct = mediumAvg > 0 ? ((shortAvg - mediumAvg) / mediumAvg) * 100 : 0

  const allInCost = card.all_in_cost != null ? Number(card.all_in_cost) : null
  let netMarginPct = null
  if (allInCost && allInCost > 0) {
    const netProceeds = todayVal * (1 - SIGNAL_FEE_RATE) - SIGNAL_SHIP_EST
    netMarginPct = ((netProceeds - allInCost) / allInCost) * 100
  }

  const roundedMomentum = Math.round(momentumPct * 10) / 10
  const roundedMargin = netMarginPct != null ? Math.round(netMarginPct * 10) / 10 : null

  let color = 'yellow', reason = 'Stable — price within normal range of baseline'
      const nextEvent = nextEventForSport(card.sport)
      const eventSoon = !!(nextEvent && nextEvent.daysUntil <= EVENT_WINDOW_DAYS)
      const marginNote = netMarginPct == null
        ? ''
        : netMarginPct < 0
          ? ` (would net ~${roundedMargin}% loss after fees/shipping at today's price — your call)`
          : ` (≈${roundedMargin}% net margin at today's price)`

      const athVal = Math.max(...withVals, todayVal)
      const pctOfPeak = athVal > 0 ? (todayVal / athVal) * 100 : 100
      const roundedPeakPct = Math.round(pctOfPeak * 10) / 10
      const nearPeak = pctOfPeak >= (100 - SIGNAL_NEAR_PEAK_PCT)
      const wellOffPeak = pctOfPeak <= (100 - SIGNAL_OFF_PEAK_PCT)
      const isElite = isElitePlayer(card.player)

      if (nearPeak) {
        color = 'green'
        reason = eventSoon
          ? `At ${roundedPeakPct}% of its tracked high price AND ${nextEvent.name} is ${nextEvent.daysUntil} day${nextEvent.daysUntil === 1 ? '' : 's'} away — strong window to sell`
          : `At ${roundedPeakPct}% of its tracked high price — this is close to the best real price this card has seen, strong window to sell`
      } else if (momentumPct <= SIGNAL_MOMENTUM_DOWN) {
        if (isElite && !wellOffPeak) {
          color = 'yellow'
          reason = `Down ${Math.abs(roundedMomentum)}% short-term, but this is a blue-chip/HOF card — these have historically held or grown in value long-term, a short dip usually isn't a sell signal`
        } else {
          color = 'red'
          reason = wellOffPeak
            ? `Price trending down ${Math.abs(roundedMomentum)}% and ${Math.round(100 - roundedPeakPct)}% off its tracked high — the peak window has likely passed, don't wait for it to come back`
            : `Price trending down ${Math.abs(roundedMomentum)}% vs recent baseline — don't list into a falling market`
        }
      } else if (momentumPct >= SIGNAL_MOMENTUM_UP && eventSoon) {
        color = 'green'
        reason = `Price up ${roundedMomentum}% AND ${nextEvent.name} is ${nextEvent.daysUntil} day${nextEvent.daysUntil === 1 ? '' : 's'} away — strong window to sell`
      } else if (momentumPct >= SIGNAL_MOMENTUM_UP) {
        color = 'green'
        reason = `Price up ${roundedMomentum}% vs baseline — good time to sell`
      } else if (eventSoon) {
        reason = isElite
          ? `${nextEvent.name} is ${nextEvent.daysUntil} day${nextEvent.daysUntil === 1 ? '' : 's'} away — worth watching, but no rush selling a card like this on anticipation alone`
          : `${nextEvent.name} is ${nextEvent.daysUntil} day${nextEvent.daysUntil === 1 ? '' : 's'} away but price hasn't reacted yet — watch closely, don't sell on anticipation alone`
      } else if (nextEvent) {
        reason = `Stable for now — ${nextEvent.name} is ${nextEvent.daysUntil} days out, worth watching as it nears`
      } else if (isElite) {
        reason = 'Stable — blue-chip/HOF card, these have historically trended up over the long run so holding is reasonable absent a specific catalyst'
      }

      reason += marginNote

      return { color, momentum_pct: roundedMomentum, net_margin_pct: roundedMargin, pct_of_peak: roundedPeakPct, is_elite_player: isElite, reason, next_event_name: nextEvent ? nextEvent.name : null, next_event_days: nextEvent ? nextEvent.daysUntil : null }
}

// ── Routes ──────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'GradeEdge API running', version: '8.9.0' })
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
    const { data: existing } = await supabase.from('cards').select('grade, sport, all_in_cost, comp_today, comp_30d, comp_history').eq('id', cardId).single()
    const prevHistory = existing?.comp_history || []
    const updatedHistory = [...prevHistory, { date: now, raw: raw ?? null, psa9: psa9 ?? null, psa10: psa10 ?? null, source: 'SportsCardsPro' }].slice(-52)
    const tierKey = tierKeyForCard({ grade: existing?.grade })
    const todayComp = pickTodayComp({ matched: true, raw, psa9, psa10 }, tierKey)
    const comp30 = find30dAgoValue(prevHistory, tierKey) ?? existing?.comp_30d ?? null
    const signal = computeSellSignal({ grade: existing?.grade, sport: existing?.sport, all_in_cost: existing?.all_in_cost, comp_today: todayComp ?? existing?.comp_today, comp_history: updatedHistory })
    const { error } = await supabase.from('cards').update({
      comp_raw: raw ?? null, comp_psa9: psa9 ?? null, comp_psa10: psa10 ?? null,
      comp_today: todayComp ?? existing?.comp_today ?? null,
      comp_30d: comp30,
      comp_source: 'SportsCardsPro',
      comp_auto_refresh: autoRefresh ?? false,
      comp_last_refreshed: now, comp_history: updatedHistory,
      signal_color: signal.color, signal_momentum_pct: signal.momentum_pct,
      signal_net_margin_pct: signal.net_margin_pct, signal_reason: signal.reason, signal_updated_at: now,
    }).eq('id', cardId)
    if (error) throw error
    res.json({ success: true, lastRefreshed: now, signal })
  } catch (err) {
    console.error('[Comps] Approve error:', err.message)
    res.status(500).json({ error: 'Failed to save comps', detail: err.message })
  }
})

// ── Buying Sector: live eBay listing alerts for watchlist players ──────────
// Unlike the SportsCardsPro-based comp pipeline above (sold prices, for valuing what you own),
// this deliberately searches eBay's Browse API for CURRENT ACTIVE listings — because a buy alert
// is about "what can I buy right now," which is exactly what active listings show. Excludes graded
// listings (buildRawQuery appends -PSA -BGS -SGC -CGC -graded) since Buying Sector is for sourcing
// raw cards to grade. A listing is flagged as a "good buy" if its price is at/below the user's
// target price, or — if no target is set — at least 15% below the current SportsCardsPro raw comp.
// Player-name autocomplete for the Buying Sector "Player Name" field. No standalone athlete
// database exists here, so this searches SportsCardsPro's card catalog for the partial query and
// dedupes the player names found in matching card titles — coverage follows whatever players SCP
// has cards for, which is effectively every notable athlete across the sports/TCG categories it sells.
app.get('/api/players/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim()
    if (q.length < 2) return res.json({ players: [] })
    const search = await scpFetch('products', { q })
    if (search.status !== 'success' || !search.products?.length) return res.json({ players: [] })
    const qLower = q.toLowerCase()
    const seen = new Map()
    for (const p of search.products) {
      const raw = extractPlayerNameFromProduct(p['product-name'])
      if (!raw) continue
      const consoleName = p['console-name'] || ''
      const sportMatch = consoleName.match(/^([A-Za-z]+)\s+Cards/)
      const sport = sportMatch ? sportMatch[1] : ''
      const parts = raw.split('/').map(s => s.trim()).filter(Boolean)
      const matched = parts.length > 1 ? parts.filter(part => part.toLowerCase().includes(qLower)) : [raw]
      const names = matched.length ? matched : parts
      for (const name of names) {
        const key = name.toLowerCase()
        if (!seen.has(key)) seen.set(key, { player: name, sport })
      }
    }
    res.json({ players: Array.from(seen.values()).slice(0, 10) })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/watchlist/alerts', async (req, res) => {
  try {
    const { items } = req.body
    if (!items || !Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items array required' })

    const results = []
    for (const item of items.slice(0, 25)) {
      try {
        const query = buildRawQuery(item.player_name, null, null, null)
        const rawItems = await fetchItems(query, 30)
        const listings = parseItems(rawItems)

        let benchmark = null, benchmarkSource = null
        if (item.target_price) {
          benchmark = Number(item.target_price)
          benchmarkSource = 'target price'
        } else {
          try {
            const scp = await fetchTiersFromSCP({ player_name: item.player_name, brand_parallel: '', card_number: '', year: '' })
            if (scp.matched && scp.raw) { benchmark = scp.raw; benchmarkSource = 'market comp' }
          } catch (e) { /* no SCP match — fall back to unranked listings below */ }
        }
        const threshold = benchmarkSource === 'target price' ? benchmark : (benchmark ? benchmark * 0.85 : null)

        const sorted = [...listings].sort((a, b) => a.price - b.price)
        const goodBuys = threshold != null ? sorted.filter(l => l.price <= threshold) : []
        const flagged = goodBuys.length > 0 ? goodBuys.slice(0, 8) : sorted.slice(0, 5)

        results.push({
          id: item.id,
          player: item.player_name,
          query,
          benchmark, benchmarkSource, threshold,
          totalListings: listings.length,
          goodBuyCount: goodBuys.length,
          listings: flagged,
        })
        await new Promise(r => setTimeout(r, 250))
      } catch (e) {
        console.error(`[WatchlistAlerts] ${item.player_name}:`, e.message)
        results.push({ id: item.id, player: item.player_name, error: e.message, listings: [] })
      }
    }
    res.json({ results, checkedAt: new Date().toISOString() })
  } catch (err) { res.status(500).json({ error: err.message }) }
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
    const { player, year, brand, cardNum, parallel, numbered } = req.query
    if (!player) return res.status(400).json({ error: 'player is required' })
    const brandFull = brand ? String(brand).trim() : ''
    const parallelFull = parallel ? String(parallel).trim() : ''
    const brandParallel = [brandFull, parallelFull].filter(Boolean).join(' ')
    const cardNumStr = cardNum ? '#' + String(cardNum).replace(/^#/, '') : ''
    const playerTrim = String(player).trim()
    // Try progressively broader queries so a slightly-off set name or missing card number
    // doesn't zero out comps that genuinely exist on SportsCardsPro.
    const attemptParts = [
      [year, brandParallel, playerTrim, cardNumStr],
      [year, brandParallel, playerTrim],
      [year, brandFull, playerTrim, cardNumStr],
      [year, brandFull, playerTrim],
      [year, playerTrim],
    ]
    const seen = new Set()
    let lastQuery = ''
    const lastName = playerTrim.split(/\s+/).pop() || ''
    const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    const isParallelProduct = name => /\[[^\]]+\]/.test(String(name || ''))

    for (const parts of attemptParts) {
      const q = parts.filter(Boolean).join(' ').trim()
      if (!q || seen.has(q)) continue
      seen.add(q); lastQuery = q
      const search = await scpFetch('products', { q })
      if (search.status === 'success' && search.products?.length) {
        // Guard against SCP's search returning an unrelated player's card for a shared insert
        // set/card-number — require the player's last name to actually appear in the product.
        const nameMatches = lastName
          ? search.products.filter(p => String(p['product-name'] || '').toLowerCase().includes(lastName.toLowerCase()))
          : search.products
        let pool = nameMatches.length ? nameMatches : (lastName ? [] : search.products)
        if (pool.length) {
          // Parallel-aware filtering: if the user specified a parallel/variation, prefer products
          // naming it; if they left it blank, prefer the base (non-bracketed) product over parallel
          // variants like "[Gold]" so we don't silently price a $8500 Gold parallel as if it were base.
          if (parallelFull) {
            const parallelLower = parallelFull.toLowerCase()
            const withParallel = pool.filter(p => String(p['product-name'] || '').toLowerCase().includes(parallelLower))
            if (withParallel.length) pool = withParallel
          } else {
            const base = pool.filter(p => !isParallelProduct(p['product-name']))
            if (base.length) pool = base
          }
          // Card-number-aware ranking (hyphen-normalized) — number-matching entries first, then alternates.
          let ranked = pool
          if (cardNumStr) {
            const num = norm(cardNumStr)
            const withNum = pool.filter(p => norm(p['product-name'] || '').includes(num))
            const withoutNum = pool.filter(p => !norm(p['product-name'] || '').includes(num))
            if (withNum.length) ranked = [...withNum, ...withoutNum]
          }
          const candidates = ranked.slice(0, 3)
          const results = []
          for (const c of candidates) {
            await new Promise(r => setTimeout(r, 1100))
            const detail = await scpFetch('product', { id: c.id })
            if (detail.status === 'success') {
              results.push({
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
              })
            }
          }
          if (results.length) {
            const [top, ...alternates] = results
            return res.json({ status: 'success', query: q, ...top, alternates })
          }
        }
      }
      await new Promise(r => setTimeout(r, 1100))
    }
    res.json({ status: 'no_match', query: lastQuery })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/comps/bulk-scp-refresh', async (req, res) => {
  try {
    // NOTE: actual Supabase column names are player/brand/parallel/card_num (not the
    // player_name/brand_parallel/card_number naming used internally by fetchTiersFromSCP) —
    // map them here rather than selecting nonexistent columns.
    const { data: rows, error } = await supabase.from('cards')
      .select('id, player, brand, parallel, card_num, year, numbered, grade, sport, all_in_cost, comp_today, comp_30d, comp_history')
    if (error) throw error
    const cards = rows.map(row => ({
      id: row.id,
      player_name: row.player || '',
      brand_parallel: [row.brand, row.parallel].filter(Boolean).join(' '),
      card_number: row.card_num || '',
      year: row.year,
      numbered: row.numbered,
      grade: row.grade,
      sport: row.sport,
      all_in_cost: row.all_in_cost,
      comp_today: row.comp_today,
      comp_30d: row.comp_30d,
      comp_history: row.comp_history,
    }))
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
            const tierKey = tierKeyForCard(card)
            const todayComp = pickTodayComp(scp, tierKey)
            const comp30 = find30dAgoValue(card.comp_history || [], tierKey) ?? card.comp_30d ?? null
            const history = [...(card.comp_history || []), { date: now, raw: scp.raw, psa9: scp.psa9, psa10: scp.psa10, source: 'SportsCardsPro' }].slice(-52)
            const signal = computeSellSignal({ grade: card.grade, sport: card.sport, all_in_cost: card.all_in_cost, comp_today: todayComp ?? card.comp_today, comp_history: history })
            await supabase.from('cards').update({
              comp_raw: scp.raw, comp_psa9: scp.psa9, comp_psa10: scp.psa10,
              comp_today: todayComp ?? card.comp_today ?? null, comp_30d: comp30,
              comp_source: 'SportsCardsPro', comp_last_refreshed: now, comp_history: history,
              signal_color: signal.color, signal_momentum_pct: signal.momentum_pct,
              signal_net_margin_pct: signal.net_margin_pct, signal_reason: signal.reason, signal_updated_at: now,
            }).eq('id', card.id)
            ok++
            console.log(`[BulkSCP] ✅ ${card.player_name} raw=${scp.raw} psa9=${scp.psa9} psa10=${scp.psa10} today(${tierKey})=${todayComp} 30d=${comp30} signal=${signal.color}`)
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

// ── ONE-TIME (and re-runnable) SIGNAL RECOMPUTE: recalculate signal_color for every card ──────
// from data already stored in Supabase (comp_today, comp_history, all_in_cost) — no external API
// calls, so it runs fast with no rate-limit wait. Use this after deploying a new signal algorithm
// version, or any time thresholds change, to re-grade all cards without re-pulling comps.
app.post('/api/signal/recompute-all', async (req, res) => {
  try {
    const { data: rows, error } = await supabase.from('cards')
      .select('id, grade, sport, all_in_cost, comp_today, comp_history')
    if (error) throw error
    res.json({ started: true, totalCards: rows.length })

    ;(async () => {
      let updated = 0, fail = 0
      const now = new Date().toISOString()
      for (const row of rows) {
        try {
          const signal = computeSellSignal(row)
          await supabase.from('cards').update({
            signal_color: signal.color, signal_momentum_pct: signal.momentum_pct,
            signal_net_margin_pct: signal.net_margin_pct, signal_reason: signal.reason, signal_updated_at: now,
          }).eq('id', row.id)
          updated++
        } catch (e) { fail++; console.error(`[SignalRecompute] ❌ ${row.id}:`, e.message) }
      }
      console.log(`[SignalRecompute] Done — updated:${updated} fail:${fail}`)
    })()
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Weekly comp auto-refresh — runs Sundays 2 AM Mountain Time.
// Now pulls through /api/comps/tiers, which is SportsCardsPro-backed as of this deploy.
cron.schedule('0 2 * * 0', async () => {
  console.log('[CronRefresh] Starting weekly comp refresh (SportsCardsPro) —', new Date().toISOString())
  try {
    // NOTE: real Supabase columns are player/brand/parallel/card_num — this select previously
    // referenced player_name/brand_parallel/card_number, which don't exist on the table, so this
    // cron has been throwing (and silently doing nothing) on every scheduled run. Fixed here.
    const { data: rows } = await supabase.from('cards')
      .select('id, player, brand, parallel, card_num, year, numbered, grade, sport, all_in_cost, comp_raw, comp_psa9, comp_psa10, comp_today, comp_30d, comp_history')
      .eq('comp_auto_refresh', true)
    if (!rows || rows.length === 0) return console.log('[CronRefresh] No cards to refresh')
    const cards = rows.map(row => ({
      id: row.id,
      player_name: row.player || '',
      brand_parallel: [row.brand, row.parallel].filter(Boolean).join(' '),
      card_number: row.card_num || '',
      year: row.year,
      numbered: row.numbered,
      grade: row.grade,
      sport: row.sport,
      all_in_cost: row.all_in_cost,
      comp_raw: row.comp_raw,
      comp_psa9: row.comp_psa9,
      comp_psa10: row.comp_psa10,
      comp_today: row.comp_today,
      comp_30d: row.comp_30d,
      comp_history: row.comp_history,
    }))
    console.log(`[CronRefresh] Refreshing ${cards.length} cards`)
    for (const card of cards) {
      try {
        const r = await fetch('https://gradeedge-api-production.up.railway.app/api/comps/tiers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ card })
        })
        const { raw, psa9, psa10, matched } = await r.json()
        const now = new Date().toISOString()
        const scpFlat = { matched: !!matched, raw: raw?.median ?? null, psa9: psa9?.median ?? null, psa10: psa10?.median ?? null }
        const tierKey = tierKeyForCard(card)
        const todayComp = pickTodayComp(scpFlat, tierKey)
        const comp30 = find30dAgoValue(card.comp_history || [], tierKey) ?? card.comp_30d ?? null
        const history = [...(card.comp_history || []), { date: now, raw: scpFlat.raw, psa9: scpFlat.psa9, psa10: scpFlat.psa10, source: 'SportsCardsPro' }].slice(-52)
        const signal = computeSellSignal({ grade: card.grade, sport: card.sport, all_in_cost: card.all_in_cost, comp_today: todayComp ?? card.comp_today, comp_history: history })
        await supabase.from('cards').update({
          comp_raw: scpFlat.raw ?? card.comp_raw,
          comp_psa9: scpFlat.psa9 ?? card.comp_psa9,
          comp_psa10: scpFlat.psa10 ?? card.comp_psa10,
          comp_today: todayComp ?? card.comp_today ?? null,
          comp_30d: comp30,
          comp_source: 'SportsCardsPro',
          comp_last_refreshed: now,
          comp_history: history,
          signal_color: signal.color, signal_momentum_pct: signal.momentum_pct,
          signal_net_margin_pct: signal.net_margin_pct, signal_reason: signal.reason, signal_updated_at: now,
        }).eq('id', card.id)
        console.log(`[CronRefresh] ✅ ${card.player_name} today(${tierKey})=${todayComp} 30d=${comp30} signal=${signal.color}`)
        await new Promise(r => setTimeout(r, 2200))
      } catch (e) { console.error(`[CronRefresh] ❌ ${card.id}:`, e.message) }
    }
  } catch (e) { console.error('[CronRefresh] Fatal:', e.message) }
}, { timezone: 'America/Denver' })

// ── Start ───────────────────────────────────────────────────────────────────
Sentry.setupExpressErrorHandler(app)

app.listen(PORT, () => {
  console.log('GradeEdge API v8.9.0 running on port ' + PORT)
  console.log('Primary comp source: SportsCardsPro (sold-price based)')
  console.log('Sell/Watch/Hold signal engine: momentum + event-timing (strike-while-hot), active')
  console.log('SportsCardsPro token configured:', !!process.env.SPORTSCARDSPRO_API_TOKEN)
  console.log('eBay Client ID configured (legacy /api/comps + /api/comps/bulk only):', !!process.env.EBAY_CLIENT_ID)
  console.log('Anthropic configured:', !!process.env.ANTHROPIC_API_KEY)
})

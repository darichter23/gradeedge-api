# GradeEdge API

Backend server for GradeEdge Pro — Boise Summit Cards

## Features
- eBay live sold comps via official Browse API
- AI card scanner via Claude Vision (photo → auto-fill card details)
- Market signals (buy/sell/hold) based on comp trends and sport seasons
- Bulk comp refresh for inventory

## Setup

### Local development
```
npm install
cp .env.example .env
# Fill in your API keys in .env
npm run dev
```

### Railway deployment
1. Push this repo to GitHub (gradeedge-api)
2. Connect to Railway.app
3. Add environment variables in Railway dashboard
4. Deploy — Railway auto-detects Node.js

## API Routes

GET  /                          Health check
GET  /api/comps                 eBay sold comps for a card
POST /api/scan                  AI card scanner (image → card data)
POST /api/comps/bulk            Refresh comps for multiple cards
GET  /api/signal                Market buy/sell/hold signal

## Environment Variables Required
- EBAY_CLIENT_ID
- EBAY_CLIENT_SECRET  
- ANTHROPIC_API_KEY

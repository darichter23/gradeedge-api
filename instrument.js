const Sentry = require('@sentry/node')

Sentry.init({
  dsn: 'https://42c042833db33045cbc5126cfe7d150e@o4511969649491968.ingest.us.sentry.io/4511969672298496',
  tracesSampleRate: 0.2,
})

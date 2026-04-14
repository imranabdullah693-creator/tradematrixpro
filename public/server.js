const express = require('express');
const crypto  = require('crypto');
const path    = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Signing helpers ───────────────────────────────────────────────────────
function hmac(message, secret) {
  return crypto.createHmac('sha256', secret).update(message).digest('base64');
}

function kuCoinHeaders(method, endpoint, body, apiKey, apiSecret, passphrase) {
  const ts  = Date.now().toString();
  const msg = ts + method.toUpperCase() + endpoint + (body ? JSON.stringify(body) : '');
  return {
    'KC-API-KEY':        apiKey,
    'KC-API-SIGN':       hmac(msg, apiSecret),
    'KC-API-TIMESTAMP':  ts,
    'KC-API-PASSPHRASE': hmac(passphrase, apiSecret),
    'KC-API-KEY-VERSION':'2',
    'Content-Type':      'application/json',
  };
}

// ─── KuCoin: fetch balance ─────────────────────────────────────────────────
app.post('/api/kucoin/balance', async (req, res) => {
  const { apiKey, apiSecret, passphrase } = req.body || {};
  if (!apiKey || !apiSecret || !passphrase)
    return res.status(400).json({ error: 'apiKey, apiSecret, and passphrase are all required.' });

  try {
    const endpoint = '/api/v1/accounts?type=trade';
    const response = await fetch('https://api.kucoin.com' + endpoint, {
      headers: kuCoinHeaders('GET', endpoint, null, apiKey, apiSecret, passphrase),
    });
    const data = await response.json();

    if (data.code !== '200000') {
      const msg =
        data.code === '400003' ? 'Invalid API key.' :
        data.code === '400004' ? 'Invalid passphrase. Make sure you enter the passphrase you set when creating this API key on KuCoin.' :
        data.code === '400005' ? 'Invalid API signature. Check your API Secret.' :
        data.code === '400100' ? 'API permission error — enable General (read) permission on KuCoin.' :
        data.msg || `KuCoin error (code ${data.code})`;
      return res.status(400).json({ error: msg });
    }

    // Only return non-zero available balances
    const balances = {};
    for (const a of data.data) {
      const avail = parseFloat(a.available);
      if (avail > 0) balances[a.currency] = (balances[a.currency] || 0) + avail;
    }

    // Get live USD prices to calculate total
    let totalUSD = 0;
    try {
      const priceRes  = await fetch('https://api.kucoin.com/api/v1/market/allTickers');
      const priceData = await priceRes.json();
      const priceMap  = { USDT: 1, USDC: 1, BUSD: 1 };
      if (priceData.code === '200000') {
        for (const t of priceData.data.ticker) {
          if (t.symbol.endsWith('-USDT')) {
            const base = t.symbol.replace('-USDT', '');
            priceMap[base] = parseFloat(t.last) || 0;
          }
        }
      }
      for (const [currency, amount] of Object.entries(balances)) {
        totalUSD += (priceMap[currency] || 0) * amount;
      }
    } catch (_) { /* price calc optional */ }

    res.json({ success: true, balances, totalUSD });
  } catch (err) {
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// ─── KuCoin: live prices (public, no auth) ─────────────────────────────────
app.get('/api/prices', async (req, res) => {
  try {
    const r    = await fetch('https://api.kucoin.com/api/v1/market/allTickers');
    const data = await r.json();
    if (data.code !== '200000') return res.status(502).json({ error: 'KuCoin price feed error' });

    const prices = {};
    const WATCH  = ['BTC-USDT','ETH-USDT','SOL-USDT','BNB-USDT','XRP-USDT','ADA-USDT','DOGE-USDT','LINK-USDT'];
    for (const t of data.data.ticker) {
      if (WATCH.includes(t.symbol)) {
        prices[t.symbol] = {
          price:  parseFloat(t.last),
          change: parseFloat(t.changeRate) * 100,
          vol:    parseFloat(t.volValue),
        };
      }
    }
    res.json({ success: true, prices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Binance: fetch balance ────────────────────────────────────────────────
app.post('/api/binance/balance', async (req, res) => {
  const { apiKey, apiSecret } = req.body || {};
  if (!apiKey || !apiSecret)
    return res.status(400).json({ error: 'apiKey and apiSecret required.' });

  try {
    const ts  = Date.now();
    const qs  = `timestamp=${ts}`;
    const sig = crypto.createHmac('sha256', apiSecret).update(qs).digest('hex');
    const url = `https://api.binance.com/api/v3/account?${qs}&signature=${sig}`;
    const r   = await fetch(url, { headers: { 'X-MBX-APIKEY': apiKey } });
    const data= await r.json();

    if (data.code) return res.status(400).json({ error: data.msg || 'Binance error' });

    const balances = {};
    for (const b of data.balances) {
      const f = parseFloat(b.free);
      if (f > 0) balances[b.asset] = f;
    }
    res.json({ success: true, balances });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Health check ──────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ─── Serve frontend ────────────────────────────────────────────────────────
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`✅ TradeMatrix server running → http://localhost:${PORT}`));

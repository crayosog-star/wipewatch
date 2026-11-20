'use strict';
// Fetches a handful of public Steam Market listings (names, icons, prices) for demo mode: node tools/fetch-demo-market.js <out.json>
const fs = require('fs');
(async () => {
  const out = process.argv[2]; if (!out) { console.error('Usage: node tools/fetch-demo-market.js <out.json>'); process.exit(1); }
  const found = [];
  for (const q of ['Tempered', 'Glowing', 'Hoodie', 'Revolver']) {
    const r = await fetch(`https://steamcommunity.com/market/search/render/?query=${encodeURIComponent(q)}&start=0&count=10&search_descriptions=0&appid=252490&norender=1`, { headers: { 'User-Agent': 'Wipewatch-demo' } });
    if (!r.ok) { console.error(q, r.status); continue; }
    const j = await r.json();
    for (const x of j.results || []) if (x.asset_description && x.asset_description.icon_url && x.sell_price > 0 && !found.some((f) => f.hash === x.hash_name)) found.push({ hash: x.hash_name, name: x.name, icon: `https://community.cloudflare.steamstatic.com/economy/image/${x.asset_description.icon_url}/256fx256f`, color: x.asset_description.name_color ? '#' + x.asset_description.name_color : '', price: x.sell_price / 100 });
    await new Promise((res) => setTimeout(res, 6000));
  }
  fs.writeFileSync(out, JSON.stringify(found, null, 1)); console.log('items:', found.length);
})();

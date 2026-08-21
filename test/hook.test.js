/* Node harness: runs hook.js against a synthetic FB-shaped GraphQL payload
   to prove the path-independent extractor finds listings. */
const fs = require('fs');
const path = require('path');

const captured = [];
const listeners = {};
const win = {
  location: { origin: 'https://www.facebook.com', href: 'https://www.facebook.com/marketplace/' },
  postMessage: (m) => captured.push(m),
  addEventListener: (k, f) => { (listeners[k] = listeners[k] || []).push(f); },
  fetch: async () => ({ text: async () => '' }),
};
global.window = win;
global.document = {
  readyState: 'complete',
  addEventListener: () => {},
  querySelectorAll: () => [],
};
global.XMLHttpRequest = function () {};
global.XMLHttpRequest.prototype = { open() {}, send() {}, addEventListener() {} };
global.self = win;
global.location = win.location;

// synthetic response: nested the way Relay actually nests things (deep, keyed by edges/node)
const payload = {
  data: {
    viewer: {
      marketplace_feed_stories: {
        edges: [
          { node: { __typename: 'MarketplaceFeedListingStoryObject', listing: {
              id: '1234567890123456',
              marketplace_listing_title: 'MacBook Pro M2 512GB space gray',
              listing_price: { amount: '52000', currency: 'PHP', formatted_amount: '₱52,000' },
              strikethrough_price: { amount: '60000', currency: 'PHP' },
              creation_time: Math.floor(Date.now() / 1000) - 1800,
              location: { reverse_geocode: { city: 'Cebu City', state: 'Cebu' } },
              primary_listing_photo: { image: { uri: 'https://scontent/x.jpg' } },
              marketplace_listing_seller: { id: '999', name: 'Juan D', join_time: 1300000000 },
              is_sold: false
          } } },
          { node: { listing: {
              id: '2234567890123456',
              custom_title: 'RTX 3070 Founders Edition',
              listing_price: { amount_with_offset: '1800000', offset: 100, currency: 'PHP' },
              creation_time: Math.floor(Date.now() / 1000) - 90000,
              is_sold: false
          } } },
          { node: { irrelevant: { id: '3334', price: { amount: '5' } } } } // no title -> must be skipped
        ]
      }
    }
  }
};

// FB sends newline-delimited JSON docs
const body = JSON.stringify(payload) + '\n' + JSON.stringify({ data: { marketplace_search: { feed_units: { edges: [] } } } });

win.fetch = async () => ({ clone: () => ({ text: async () => body }) });

require(path.join(__dirname, '..', 'src', 'hook.js'));

(async () => {
  await window.fetch('https://www.facebook.com/api/graphql/', { method: 'POST', body: 'fb_dtsg=ABC123&doc_id=987&fb_api_req_friendly_name=MarketplaceSearch' });
  await new Promise(r => setTimeout(r, 50));

  const msgs = captured.filter(m => m.kind === 'listings');
  const tok = captured.find(m => m.kind === 'tokens');
  const listings = msgs.length ? msgs[0].payload.listings : [];

  console.log('tokens captured:', tok && tok.payload.fb_dtsg);
  console.log('listings found:', listings.length);
  console.log(JSON.stringify(listings, null, 2));

  const ok =
    listings.length === 2 &&
    listings.some(l => l.price === 52000 && l.sellerJoinYear === 2011 && l.strikethroughPrice === 60000) &&
    listings.some(l => l.price === 18000) &&
    tok && tok.payload.fb_dtsg === 'ABC123';
  console.log(ok ? '\nPASS' : '\nFAIL');
  process.exit(ok ? 0 : 1);
})();

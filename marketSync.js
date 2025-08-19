// src/marketSync.js
import fetch from "node-fetch";
import "dotenv/config.js";

const SHOP = process.env.SHOP_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = "2025-07";
const BASE = `https://${SHOP}/admin/api/${API_VERSION}`;

const marketIds = (process.env.MARKET_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// Cache: MarketID -> PublicationID
const pubCache = new Map();

async function shopifyGraphQL(query, variables) {
  const res = await fetch(`${BASE}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors || json.data?.userErrors?.length) {
    console.error("❌ Shopify GraphQL errors:", json.errors || json.data.userErrors);
  }
  return json;
}

async function getPublicationIdForMarket(marketId) {
  if (pubCache.has(marketId)) return pubCache.get(marketId);

  const q = `
    query($id: ID!) {
      market(id: $id) {
        id
        name
        catalogs(first: 5) {
          nodes {
            id
            title
            publication { id }
          }
        }
      }
    }
  `;
  const { data } = await shopifyGraphQL(q, { id: marketId });
  const catalogs = data?.market?.catalogs?.nodes || [];
  const pubId = catalogs[0]?.publication?.id;
  if (!pubId) throw new Error(`No publication found for market ${marketId}`);
  pubCache.set(marketId, pubId);
  return pubId;
}

async function publicationUpdate(pubId, { add = [], remove = [] }) {
  const m = `
    mutation PubUpdate($id: ID!, $input: PublicationUpdateInput!) {
      publicationUpdate(id: $id, input: $input) {
        publication { id }
        userErrors { field message }
      }
    }
  `;
  const input = {};
  if (add.length) input.publishablesToAdd = add;
  if (remove.length) input.publishablesToRemove = remove;

  const { data } = await shopifyGraphQL(m, { id: pubId, input });
  return data?.publicationUpdate?.userErrors || [];
}

export async function syncMarkets(productGid, allZero) {
  console.log("syncMarkets()", { productGid, allZero, marketIds });
  for (const marketId of marketIds) {
    const publicationId = await getPublicationIdForMarket(marketId);
    if (allZero) {
      const errs = await publicationUpdate(publicationId, { remove: [productGid] });
      console.log(`🛑 Unpublished from market ${marketId}`, errs);
    } else {
      const errs = await publicationUpdate(publicationId, { add: [productGid] });
      console.log(`✅ Published to market ${marketId}`, errs);
    }
  }
}

// webhooks.js
import express from "express";
import fetch from "node-fetch";
import "dotenv/config.js";
import { syncMarkets } from "./marketSync.js";

const router = express.Router();

const SHOP = process.env.SHOP_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = "2025-07";
const BASE = `https://${SHOP}/admin/api/${API_VERSION}`;

const CENTRAL_LOCATION_ID = String(process.env.CENTRAL_LOCATION_ID || "").trim();
const CENTRAL_LOCATION_GID = `gid://shopify/Location/${CENTRAL_LOCATION_ID}`;

// === GraphQL: producto + inventoryItem ids de TODAS las variantes ===
async function getProductByInventoryItem(inventoryItemId) {
  const query = `
    query($id: ID!) {
      inventoryItem(id: $id) {
        variant {
          product {
            id
            title
            variants(first: 250) {
              edges {
                node {
                  id
                  inventoryItem { id }  # gid://shopify/InventoryItem/XXXX
                }
              }
            }
          }
        }
      }
    }
  `;
  const res = await fetch(`${BASE}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": TOKEN,
    },
    body: JSON.stringify({
      query,
      variables: { id: `gid://shopify/InventoryItem/${inventoryItemId}` },
    }),
  });
  const json = await res.json();
  if (json.errors) console.error("❌ GraphQL errors:", json.errors);
  return json.data?.inventoryItem?.variant?.product || null;
}

// === REST: /admin/api/<ver>/inventory_levels.json para n inventory_items en UNA location ===
async function getAvailableByInventoryItemIdsREST(inventoryItemIds, centralLocationId) {
  if (!inventoryItemIds.length) return {};
  // Shopify permite hasta ~50 ids por llamada; partimos por si acaso
  const chunkSize = 50;
  const map = {};

  for (let i = 0; i < inventoryItemIds.length; i += chunkSize) {
    const chunk = inventoryItemIds.slice(i, i + chunkSize);
    // Pasar ids como números, no GIDs
    const numericIds = chunk.map(gid => gid.split("/").pop()).join(",");
    const url = `${BASE}/inventory_levels.json?inventory_item_ids=${numericIds}&location_ids=${centralLocationId}`;

    const res = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": TOKEN,
        "Content-Type": "application/json",
      },
    });
    const json = await res.json();
    // json.inventory_levels => [{inventory_item_id, location_id, available, ...}]
    for (const lvl of json.inventory_levels || []) {
      map[String(lvl.inventory_item_id)] = lvl.available ?? 0;
    }
  }
  return map; // { "53414638780793": 0, ... }
}


// === Ruta webhook ===
router.post("/webhooks/inventory_levels/update", async (req, res) => {
  try {
    const { inventory_item_id, location_id } = req.body;

    // Solo reaccionamos a la location central
    if (String(location_id) !== CENTRAL_LOCATION_ID) {
      return res.json({ ok: true, skip: "Not central location" });
    }

    const product = await getProductByInventoryItem(inventory_item_id);
    if (!product?.id) throw new Error("Product not found for inventory item");

const variants = product.variants.edges.map(e => e.node);
const inventoryItemGids = variants.map(v => v.inventoryItem.id); // gid://shopify/InventoryItem/XXXX
const availabilityMap = await getAvailableByInventoryItemIdsREST(
  inventoryItemGids,
  CENTRAL_LOCATION_ID
);

// allZero si TODAS las variantes tienen 0 en central
const allZero = inventoryItemGids.every(gid => {
  const idNum = gid.split("/").pop();
  const avail = availabilityMap[idNum] ?? 0;
  return Number(avail) === 0;
});

console.log({
  productId: product.id,
  productTitle: product.title,
  centralLocation: CENTRAL_LOCATION_ID,
  availabilityMap,
  allZero,
});


    console.log({
      productId: product.id,
      productTitle: product.title,
      allZero,
    });

    await syncMarkets(product.id, allZero);

    res.json({ ok: true, productId: product.id, allZero });
  } catch (err) {
    console.error("❌ Error in webhook:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;

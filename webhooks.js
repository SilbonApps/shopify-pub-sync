// webhooks.js
import express from "express";
import fetch from "node-fetch";
import crypto from "node:crypto";
import "dotenv/config.js";
import { syncMarkets } from "./marketSync.js";
import { httpsAgent } from "./agent.js";

const router = express.Router();

const SHOP = process.env.SHOP_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || "";
const API_VERSION = "2025-07";
const BASE = `https://${SHOP}/admin/api/${API_VERSION}`;

const CENTRAL_LOCATION_ID = String(process.env.CENTRAL_LOCATION_ID || "").trim();
const DEBOUNCE_MS = Number(process.env.DEBOUNCE_MS || 8000);

// Caches en memoria (instancia única; si el proceso se reinicia solo cuesta
// una consulta extra y una pasada de sync por producto)
const itemToProduct = new Map(); // inventory_item_id (num string) -> productGid
const productItems = new Map(); // productGid -> [inventory_item_id, ...]
const pendingTimers = new Map(); // productGid -> Timeout del debounce
const lastAllZero = new Map(); // productGid -> último allZero sincronizado

// === HMAC: Shopify firma el body crudo con el secret del webhook ===
function verifyHmac(req) {
  if (!WEBHOOK_SECRET) return true; // sin secret configurado, no se verifica
  const header = req.get("X-Shopify-Hmac-Sha256") || "";
  if (!Buffer.isBuffer(req.body)) return false;
  const digest = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(req.body)
    .digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

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
    agent: httpsAgent,
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
    const url = `${BASE}/inventory_levels.json?inventory_item_ids=${chunk.join(",")}&location_ids=${centralLocationId}`;

    const res = await fetch(url, {
      agent: httpsAgent,
      headers: {
        "X-Shopify-Access-Token": TOKEN,
        "Content-Type": "application/json",
      },
    });
    const json = await res.json();
    for (const lvl of json.inventory_levels || []) {
      map[String(lvl.inventory_item_id)] = lvl.available ?? 0;
    }
  }
  return map; // { "53414638780793": 0, ... }
}

function cacheProduct(product) {
  const ids = product.variants.edges.map(e => e.node.inventoryItem.id.split("/").pop());
  productItems.set(product.id, ids);
  for (const id of ids) itemToProduct.set(id, product.id);
}

// Resuelve el producto del item (con caché) y (re)arma el timer de debounce.
// Todos los webhooks del mismo producto dentro de la ventana colapsan en UNA pasada.
async function enqueue(inventoryItemId) {
  let productGid = itemToProduct.get(inventoryItemId);
  if (!productGid) {
    const product = await getProductByInventoryItem(inventoryItemId);
    if (!product?.id) {
      console.error("❌ Product not found for inventory item", inventoryItemId);
      return;
    }
    cacheProduct(product);
    productGid = product.id;
  }
  schedule(productGid);
}

function schedule(productGid) {
  const t = pendingTimers.get(productGid);
  if (t) clearTimeout(t);
  pendingTimers.set(
    productGid,
    setTimeout(() => {
      pendingTimers.delete(productGid);
      processProduct(productGid).catch(err =>
        console.error("❌ Error processing", productGid, err)
      );
    }, DEBOUNCE_MS)
  );
}

async function processProduct(productGid) {
  const itemIds = productItems.get(productGid);
  if (!itemIds?.length) return;

  const availabilityMap = await getAvailableByInventoryItemIdsREST(
    itemIds,
    CENTRAL_LOCATION_ID
  );

  // allZero si TODAS las variantes tienen 0 en central
  const allZero = itemIds.every(id => Number(availabilityMap[id] ?? 0) === 0);

  if (lastAllZero.get(productGid) === allZero) {
    console.log(`⏭️  ${productGid} allZero=${allZero} sin cambios, Markets no se tocan`);
    return;
  }

  console.log({ productGid, allZero, variants: itemIds.length });
  await syncMarkets(productGid, allZero);
  lastAllZero.set(productGid, allZero);
}

// === Ruta webhook ===
// req.body es un Buffer (express.raw en server.js) para poder verificar la firma.
// Se responde 200 de inmediato: Shopify solo necesita el 2xx en <5s; el trabajo
// pesado se hace después, agrupado por producto.
router.post("/webhooks/inventory_levels/update", (req, res) => {
  if (!verifyHmac(req)) return res.sendStatus(401);

  let body;
  try {
    body = JSON.parse(req.body);
  } catch {
    return res.sendStatus(400);
  }

  const { inventory_item_id, location_id } = body;
  res.sendStatus(200);

  // Solo reaccionamos a la location central
  if (String(location_id) !== CENTRAL_LOCATION_ID) return;

  enqueue(String(inventory_item_id)).catch(err =>
    console.error("❌ Error in webhook queue:", err)
  );
});

export default router;

// src/sync.mjs
// Del inventory_item al producto y de ahi a los Markets. Las caches son de
// modulo: en un contenedor caliente de Lambda ahorran la consulta de
// resolucion y, con lastAllZero, la pasada entera; en uno frio solo cuesta
// una consulta extra. La idempotencia real no depende de ellas: syncMarkets
// comprueba el estado en Shopify antes de mutar.

import { getProductByInventoryItem, getAvailableByInventoryItemIdsREST, getProductStatus } from './shopify.mjs';
import { syncMarkets } from './marketSync.mjs';

const itemToProduct = new Map(); // inventory_item_id -> productGid
const productItems = new Map(); // productGid -> [inventory_item_id, ...]
const lastAllZero = new Map(); // productGid -> ultimo allZero sincronizado
// Solo se cachea ACTIVE: un borrador o archivado se vuelve a consultar en cada
// pasada para que, en cuanto se active, la siguiente actualizacion de stock lo
// publique. Un producto no activo no se puede publicar en ningun Market, y
// publicationUpdate sobre el responde OK sin hacer nada (57 de 60 productos
// de la primera hora en AWS eran borradores: 3 mutaciones inutiles cada uno).
const activeProducts = new Set(); // productGid con status ACTIVE visto

function cacheProduct(product) {
  const ids = product.variants.edges.map((e) => e.node.inventoryItem.id.split('/').pop());
  productItems.set(product.id, ids);
  for (const id of ids) itemToProduct.set(id, product.id);
  if (product.status === 'ACTIVE') activeProducts.add(product.id);
}

async function isActive(productGid) {
  if (activeProducts.has(productGid)) return true;
  const status = await getProductStatus(productGid);
  if (status === 'ACTIVE') {
    activeProducts.add(productGid);
    return true;
  }
  console.log(`${productGid} status=${status}: no se publica en Markets`);
  return false;
}

export async function resolveProduct(inventoryItemId) {
  const cached = itemToProduct.get(inventoryItemId);
  if (cached) return cached;
  const product = await getProductByInventoryItem(inventoryItemId);
  if (!product?.id) return null;
  cacheProduct(product);
  return product.id;
}

export async function processProduct(productGid) {
  const itemIds = productItems.get(productGid);
  if (!itemIds?.length) return { productGid, skipped: 'sin variantes en cache' };
  if (!(await isActive(productGid))) return { productGid, skipped: 'producto no activo' };

  const central = String(process.env.CENTRAL_LOCATION_ID || '').trim();
  const availability = await getAvailableByInventoryItemIdsREST(itemIds, central);
  const allZero = itemIds.every((id) => Number(availability[id] ?? 0) === 0);

  if (lastAllZero.get(productGid) === allZero) {
    console.log(`${productGid} allZero=${allZero} sin cambios desde la ultima pasada`);
    return { productGid, allZero, touched: 0 };
  }

  console.log(JSON.stringify({ productGid, allZero, variants: itemIds.length }));
  const touched = await syncMarkets(productGid, allZero);
  lastAllZero.set(productGid, allZero);
  return { productGid, allZero, touched };
}

// Procesa un lote de inventory_item_ids: dedup de items, dedup de productos,
// una pasada por producto. Devuelve, por item, el resultado o el error, para
// que el worker pueda marcar fallos parciales.
export async function processBatch(inventoryItemIds) {
  const unique = [...new Set(inventoryItemIds.map(String))];
  const itemsByProduct = new Map(); // productGid -> [itemId]
  const results = new Map(); // itemId -> { ok, error?, result? }

  for (const itemId of unique) {
    try {
      const productGid = await resolveProduct(itemId);
      if (!productGid) {
        console.error('Producto no encontrado para inventory item', itemId);
        results.set(itemId, { ok: true, result: { skipped: 'producto no encontrado' } });
        continue;
      }
      if (!itemsByProduct.has(productGid)) itemsByProduct.set(productGid, []);
      itemsByProduct.get(productGid).push(itemId);
    } catch (error) {
      results.set(itemId, { ok: false, error });
    }
  }

  for (const [productGid, itemIds] of itemsByProduct) {
    try {
      const result = await processProduct(productGid);
      for (const itemId of itemIds) results.set(itemId, { ok: true, result });
    } catch (error) {
      console.error('Error procesando', productGid, error);
      for (const itemId of itemIds) results.set(itemId, { ok: false, error });
    }
  }

  return results;
}

export function resetCaches() {
  itemToProduct.clear();
  productItems.clear();
  lastAllZero.clear();
  activeProducts.clear();
}

// src/shopify.mjs
// Acceso a la Admin API de Shopify (GraphQL y REST) con el fetch nativo de
// Node 22. Las credenciales se leen en cada llamada, no al importar, para que
// los secretos cargados de SSM al arrancar la Lambda se vean sin reordenar
// imports.

export const API_VERSION = '2025-07';

function config() {
  const shop = process.env.SHOP_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!shop || !token) throw new Error('Faltan SHOP_DOMAIN o SHOPIFY_ADMIN_TOKEN');
  return { base: `https://${shop}/admin/api/${API_VERSION}`, token };
}

export async function shopifyGraphQL(query, variables) {
  const { base, token } = config();
  const res = await fetch(`${base}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify GraphQL HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) {
    console.error('Shopify GraphQL errors:', JSON.stringify(json.errors));
    throw new Error('Shopify GraphQL devolvio errores');
  }
  return json;
}

// Producto (id + inventoryItem de TODAS sus variantes) a partir de un inventory_item_id.
export async function getProductByInventoryItem(inventoryItemId) {
  const query = `
    query($id: ID!) {
      inventoryItem(id: $id) {
        variant {
          product {
            id
            title
            status
            variants(first: 250) {
              edges { node { id inventoryItem { id } } }
            }
          }
        }
      }
    }
  `;
  const json = await shopifyGraphQL(query, {
    id: `gid://shopify/InventoryItem/${inventoryItemId}`,
  });
  return json.data?.inventoryItem?.variant?.product || null;
}

// Estado del producto (ACTIVE / DRAFT / ARCHIVED). Consulta ligera para los
// productos que no estaban activos la ultima vez: su estado no se cachea.
export async function getProductStatus(productGid) {
  const json = await shopifyGraphQL(`query($id: ID!) { product(id: $id) { status } }`, { id: productGid });
  return json.data?.product?.status || null;
}

// REST inventory_levels.json: available de n inventory_items en UNA ubicacion.
export async function getAvailableByInventoryItemIdsREST(inventoryItemIds, locationId) {
  if (!inventoryItemIds.length) return {};
  const { base, token } = config();
  const chunkSize = 50;
  const map = {};
  for (let i = 0; i < inventoryItemIds.length; i += chunkSize) {
    const chunk = inventoryItemIds.slice(i, i + chunkSize);
    const url = `${base}/inventory_levels.json?inventory_item_ids=${chunk.join(',')}&location_ids=${locationId}`;
    const res = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new Error(`Shopify REST inventory_levels HTTP ${res.status}`);
    const json = await res.json();
    for (const lvl of json.inventory_levels || []) {
      map[String(lvl.inventory_item_id)] = lvl.available ?? 0;
    }
  }
  return map;
}

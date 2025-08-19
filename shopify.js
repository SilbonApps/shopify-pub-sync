// shopify.js
import fetch from "node-fetch";

const SHOP = process.env.SHOP_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = "2025-07";

if (!SHOP || !TOKEN) {
  console.error("❌ Falta SHOP_DOMAIN o SHOPIFY_ADMIN_TOKEN en .env");
  process.exit(1);
}

export async function gql(query, variables = {}) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) console.error("GraphQL errors:", JSON.stringify(json.errors));
  return json;
}

export async function getPublications() {
  const q = `{ publications(first: 100) { edges { node { id name } } } }`;
  const r = await gql(q);
  return r?.data?.publications?.edges?.map(e => e.node) || [];
}

export async function getProductByInventoryItemId(inventoryItemId) {
  const q = `
    query($id: ID!) {
      inventoryItem(id: $id) {
        variant { product { id title status } }
      }
    }
  `;
  const v = { id: `gid://shopify/InventoryItem/${inventoryItemId}` };
  const r = await gql(q, v);
  return r?.data?.inventoryItem?.variant?.product || null;
}

export async function getProductResourcePublications(productId) {
  const q = `
    query($id: ID!) {
      product(id: $id) {
        resourcePublications(first: 100) {
          edges { node { isPublished publication { id name } } }
        }
      }
    }
  `;
  const r = await gql(q, { id: productId });
  return r?.data?.product?.resourcePublications?.edges?.map(e => e.node) || [];
}

export async function publishToPublication(productId, publicationId) {
  const m = `
    mutation($id: ID!, $pub: ID!) {
      publishablePublish(id: $id, input: { publicationId: $pub }) {
        userErrors { field message }
      }
    }
  `;
  return gql(m, { id: productId, pub: publicationId });
}

export async function unpublishFromPublication(productId, publicationId) {
  const m = `
    mutation($id: ID!, $pub: ID!) {
      publishableUnpublish(id: $id, input: { publicationId: $pub }) {
        userErrors { field message }
      }
    }
  `;
  return gql(m, { id: productId, pub: publicationId });
}

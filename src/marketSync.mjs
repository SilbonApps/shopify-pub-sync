// src/marketSync.mjs
// Publica o despublica un producto en los Markets de MARKET_IDS.
//
// Antes de mutar se consulta si el producto ya esta en el estado deseado en
// cada publicacion (publishedOnPublication) y solo se toca lo que difiere.
// Asi la operacion es idempotente de verdad: repetir un webhook, procesarlo
// dos veces por un reintento de SQS o arrancar en un contenedor sin cache no
// genera mutaciones de mas.

import { shopifyGraphQL } from './shopify.mjs';

// MarketID -> PublicationID (vive lo que viva el contenedor)
const pubCache = new Map();

function marketIds() {
  return (process.env.MARKET_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function getPublicationIdForMarket(marketId) {
  if (pubCache.has(marketId)) return pubCache.get(marketId);
  const q = `
    query($id: ID!) {
      market(id: $id) {
        id
        name
        catalogs(first: 5) { nodes { id title publication { id } } }
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

// { publicationId: true|false } para el producto, en UNA consulta con alias.
async function getPublishedState(productGid, publicationIds) {
  const vars = { id: productGid };
  const fields = publicationIds.map((pubId, i) => {
    vars[`p${i}`] = pubId;
    return `p${i}: publishedOnPublication(publicationId: $p${i})`;
  });
  const decl = publicationIds.map((_, i) => `$p${i}: ID!`).join(', ');
  const q = `query($id: ID!, ${decl}) { product(id: $id) { ${fields.join(' ')} } }`;
  const { data } = await shopifyGraphQL(q, vars);
  const product = data?.product;
  if (!product) throw new Error(`Producto no encontrado: ${productGid}`);
  const state = {};
  publicationIds.forEach((pubId, i) => {
    state[pubId] = Boolean(product[`p${i}`]);
  });
  return state;
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

// Devuelve cuantas publicaciones se han tocado.
export async function syncMarkets(productGid, allZero) {
  const markets = marketIds();
  if (!markets.length) {
    console.warn('MARKET_IDS vacio: no hay nada que sincronizar');
    return 0;
  }
  const publicationIds = [];
  for (const marketId of markets) publicationIds.push(await getPublicationIdForMarket(marketId));

  const state = await getPublishedState(productGid, publicationIds);
  const wantPublished = !allZero;
  let touched = 0;

  await Promise.all(
    publicationIds.map(async (pubId, i) => {
      if (state[pubId] === wantPublished) return;
      const errs = wantPublished
        ? await publicationUpdate(pubId, { add: [productGid] })
        : await publicationUpdate(pubId, { remove: [productGid] });
      if (errs.length) {
        console.error(`Market ${markets[i]} userErrors:`, JSON.stringify(errs));
        throw new Error(`publicationUpdate fallo en ${markets[i]}`);
      }
      touched += 1;
      console.log(`${wantPublished ? 'Publicado en' : 'Despublicado de'} market ${markets[i]} (${productGid})`);
    })
  );

  if (!touched) {
    console.log(`${productGid} ya estaba ${wantPublished ? 'publicado' : 'despublicado'} en todos los Markets`);
  }
  return touched;
}

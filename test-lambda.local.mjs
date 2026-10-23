// test-lambda.local.mjs
// Invoca los dos handlers de Lambda con eventos sinteticos (API Gateway HTTP
// API v2 y SQS), sin red: fetch queda interceptado con respuestas de Shopify
// simuladas y el envio a SQS se sustituye por una lista en memoria.
//
//   npm run test:lambda

import assert from 'node:assert/strict';
import crypto from 'node:crypto';

delete process.env.SECRETS_SSM_PREFIX;
Object.assign(process.env, {
  AWS_LAMBDA_FUNCTION_NAME: 'test-local',
  SHOP_DOMAIN: 'ejemplo.myshopify.com',
  SHOPIFY_ADMIN_TOKEN: 'shpat_de_mentira',
  CENTRAL_LOCATION_ID: '111',
  MARKET_IDS: 'gid://shopify/Market/1,gid://shopify/Market/2',
  QUEUE_URL: 'https://sqs.eu-central-1.amazonaws.com/123456789012/pruebas',
});
delete process.env.SHOPIFY_WEBHOOK_SECRET;

const WEBHOOK_SECRET = 'secreto-de-prueba';

// --- Shopify simulado --------------------------------------------------------
// Dos productos: P1 con items 1001 y 1002, P2 con item 2001.
const PRODUCTS = {
  1001: 'gid://shopify/Product/1',
  1002: 'gid://shopify/Product/1',
  2001: 'gid://shopify/Product/2',
};
const ITEMS = { 'gid://shopify/Product/1': ['1001', '1002'], 'gid://shopify/Product/2': ['2001'] };
let availability = { 1001: 0, 1002: 0, 2001: 5 }; // P1 agotado, P2 con stock
let published = {
  'gid://shopify/Product/1': { 'gid://shopify/Publication/10': true, 'gid://shopify/Publication/20': true },
  'gid://shopify/Product/2': { 'gid://shopify/Publication/10': false, 'gid://shopify/Publication/20': true },
};

const calls = { resolve: 0, levels: 0, market: 0, state: 0, status: 0, mutations: [] };
const DRAFTS = new Set(); // productos en borrador para la prueba

function graphqlResponse(query, variables) {
  if (query.includes('inventoryItem(id:')) {
    calls.resolve += 1;
    const itemId = variables.id.split('/').pop();
    const productGid = PRODUCTS[itemId];
    if (!productGid) return { data: { inventoryItem: null } };
    return {
      data: {
        inventoryItem: {
          variant: {
            product: {
              id: productGid,
              title: 'Producto',
              status: DRAFTS.has(productGid) ? 'DRAFT' : 'ACTIVE',
              variants: {
                edges: ITEMS[productGid].map((id) => ({
                  node: { id: `gid://shopify/ProductVariant/${id}`, inventoryItem: { id: `gid://shopify/InventoryItem/${id}` } },
                })),
              },
            },
          },
        },
      },
    };
  }
  if (query.includes('product(id: $id) { status }')) {
    calls.status += 1;
    return { data: { product: { status: DRAFTS.has(variables.id) ? 'DRAFT' : 'ACTIVE' } } };
  }
  if (query.includes('market(id:')) {
    calls.market += 1;
    const n = variables.id.split('/').pop();
    return { data: { market: { id: variables.id, name: `M${n}`, catalogs: { nodes: [{ id: 'c', title: 't', publication: { id: `gid://shopify/Publication/${n}0` } }] } } } };
  }
  if (query.includes('publishedOnPublication')) {
    calls.state += 1;
    const state = published[variables.id];
    const product = {};
    Object.keys(variables).filter((k) => k !== 'id').forEach((k) => { product[k] = state[variables[k]]; });
    return { data: { product } };
  }
  if (query.includes('publicationUpdate(')) {
    const { id, input } = variables;
    for (const gid of input.publishablesToAdd || []) { published[gid][id] = true; calls.mutations.push(['add', id, gid]); }
    for (const gid of input.publishablesToRemove || []) { published[gid][id] = false; calls.mutations.push(['remove', id, gid]); }
    return { data: { publicationUpdate: { publication: { id }, userErrors: [] } } };
  }
  throw new Error(`GraphQL no simulado: ${query.slice(0, 60)}`);
}

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.endsWith('/graphql.json')) {
    const { query, variables } = JSON.parse(init.body);
    return new Response(JSON.stringify(graphqlResponse(query, variables)), { status: 200 });
  }
  if (u.includes('/inventory_levels.json')) {
    calls.levels += 1;
    const ids = new URL(u).searchParams.get('inventory_item_ids').split(',');
    return new Response(
      JSON.stringify({ inventory_levels: ids.map((id) => ({ inventory_item_id: Number(id), location_id: 111, available: availability[id] ?? 0 })) }),
      { status: 200 }
    );
  }
  throw new Error(`fetch bloqueado en la prueba: ${u}`);
};

const { handler: webhook, deps } = await import('./server/webhook.mjs');
const { handler: worker } = await import('./server/worker.mjs');
const { resetCaches } = await import('./src/sync.mjs');

const queued = [];
deps.sendToQueue = async (payload) => { queued.push(payload); };

const silent = () => {};
const realLog = console.log;
console.log = silent;
console.warn = silent;
console.error = silent;

function sign(body) {
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(Buffer.from(body, 'utf8')).digest('base64');
}

function httpEvent({ method = 'POST', path = '/webhooks/inventory_levels/update', body, signature, base64 = true }) {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers: {
      host: 'pruebas.execute-api.eu-central-1.amazonaws.com',
      'content-type': 'application/json',
      ...(signature ? { 'x-shopify-hmac-sha256': signature } : {}),
    },
    requestContext: { http: { method, path }, requestId: crypto.randomUUID() },
    body: body === undefined ? undefined : base64 ? Buffer.from(body, 'utf8').toString('base64') : body,
    isBase64Encoded: Boolean(body !== undefined && base64),
  };
}

function sqsEvent(bodies) {
  return {
    Records: bodies.map((b, i) => ({ messageId: `m${i + 1}`, body: typeof b === 'string' ? b : JSON.stringify(b) })),
  };
}

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    realLog(`  ok   ${name}`);
  } catch (e) {
    failures += 1;
    realLog(`  FAIL ${name}\n       ${e.message}`);
  }
}

realLog('Receptor del webhook');

await check('sin secreto configurado -> 503 y no encola', async () => {
  const res = await webhook(httpEvent({ body: '{}', signature: 'x' }));
  assert.equal(res.statusCode, 503);
  assert.equal(queued.length, 0);
});

process.env.SHOPIFY_WEBHOOK_SECRET = WEBHOOK_SECRET;

await check('GET /health -> 200', async () => {
  const res = await webhook(httpEvent({ method: 'GET', path: '/health' }));
  assert.equal(res.statusCode, 200);
});

await check('firma mala -> 401', async () => {
  const body = JSON.stringify({ inventory_item_id: 1001, location_id: 111 });
  const res = await webhook(httpEvent({ body, signature: sign(body + 'x') }));
  assert.equal(res.statusCode, 401);
  assert.equal(queued.length, 0);
});

await check('firma buena (base64), otra ubicacion -> 200 y NO encola', async () => {
  const body = JSON.stringify({ inventory_item_id: 1001, location_id: 999 });
  const res = await webhook(httpEvent({ body, signature: sign(body) }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, queued: false });
  assert.equal(queued.length, 0);
});

await check('firma buena (base64), ubicacion central -> 200 y encola', async () => {
  const body = JSON.stringify({ inventory_item_id: 1001, location_id: 111 });
  const res = await webhook(httpEvent({ body, signature: sign(body) }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, queued: true });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].inventoryItemId, '1001');
});

await check('cuerpo sin base64 tambien firma bien', async () => {
  const body = JSON.stringify({ inventory_item_id: 2001, location_id: 111 });
  const res = await webhook(httpEvent({ body, signature: sign(body), base64: false }));
  assert.equal(res.statusCode, 200);
  assert.equal(queued.length, 2);
});

await check('JSON roto con firma buena -> 400', async () => {
  const body = '{no es json';
  const res = await webhook(httpEvent({ body, signature: sign(body) }));
  assert.equal(res.statusCode, 400);
});

realLog('Worker de la cola');

await check('lote de 3 mensajes (2 variantes de P1 + 1 de P2): 2 resoluciones, 2 pasadas, allZero correcto', async () => {
  resetCaches();
  Object.assign(calls, { resolve: 0, levels: 0, market: 0, state: 0, mutations: [] });
  const res = await worker(sqsEvent([
    { inventoryItemId: '1001' },
    { inventoryItemId: '1002' },
    { inventoryItemId: '2001' },
  ]));
  assert.deepEqual(res, { batchItemFailures: [] });
  assert.equal(calls.resolve, 2, 'P1 se resuelve una vez (la segunda variante sale de la cache) y P2 otra');
  assert.equal(calls.levels, 2, 'una consulta de stock por producto');
  assert.equal(calls.state, 2, 'una consulta de estado por producto');
  // P1 agotado y publicado en las dos -> se despublica de las dos.
  // P2 con stock, publicado solo en /20 -> se publica en /10.
  assert.deepEqual(calls.mutations.sort(), [
    ['add', 'gid://shopify/Publication/10', 'gid://shopify/Product/2'],
    ['remove', 'gid://shopify/Publication/10', 'gid://shopify/Product/1'],
    ['remove', 'gid://shopify/Publication/20', 'gid://shopify/Product/1'],
  ].sort());
});

await check('repetir el mismo lote no muta nada (cache caliente)', async () => {
  Object.assign(calls, { resolve: 0, levels: 0, market: 0, state: 0, mutations: [] });
  const res = await worker(sqsEvent([{ inventoryItemId: '1001' }, { inventoryItemId: '2001' }]));
  assert.deepEqual(res, { batchItemFailures: [] });
  assert.equal(calls.resolve, 0);
  assert.equal(calls.mutations.length, 0);
});

await check('contenedor frio con Shopify ya en el estado deseado: consulta estado y no muta', async () => {
  resetCaches();
  Object.assign(calls, { resolve: 0, levels: 0, market: 0, state: 0, mutations: [] });
  const res = await worker(sqsEvent([{ inventoryItemId: '2001' }]));
  assert.deepEqual(res, { batchItemFailures: [] });
  assert.equal(calls.state, 1);
  assert.equal(calls.mutations.length, 0);
});

await check('stock que vuelve: P1 se republica en las dos', async () => {
  availability = { 1001: 3, 1002: 0, 2001: 5 };
  Object.assign(calls, { resolve: 0, levels: 0, market: 0, state: 0, mutations: [] });
  const res = await worker(sqsEvent([{ inventoryItemId: '1002' }]));
  assert.deepEqual(res, { batchItemFailures: [] });
  assert.deepEqual(calls.mutations.sort(), [
    ['add', 'gid://shopify/Publication/10', 'gid://shopify/Product/1'],
    ['add', 'gid://shopify/Publication/20', 'gid://shopify/Product/1'],
  ].sort());
});

await check('producto en borrador: ni stock ni Markets, y al activarse la siguiente pasada lo publica', async () => {
  resetCaches();
  DRAFTS.add('gid://shopify/Product/2');
  published['gid://shopify/Product/2'] = { 'gid://shopify/Publication/10': false, 'gid://shopify/Publication/20': false };
  Object.assign(calls, { resolve: 0, levels: 0, market: 0, state: 0, status: 0, mutations: [] });
  let res = await worker(sqsEvent([{ inventoryItemId: '2001' }]));
  assert.deepEqual(res, { batchItemFailures: [] });
  assert.equal(calls.levels, 0, 'no consulta stock de un borrador');
  assert.equal(calls.mutations.length, 0, 'no toca Markets');
  // Segunda pasada en caliente, sigue en borrador: vuelve a preguntar el estado (no se cachea)
  res = await worker(sqsEvent([{ inventoryItemId: '2001' }]));
  assert.equal(calls.status, 2, 'el estado de un borrador se consulta en cada pasada (una por pasada)');
  assert.equal(calls.mutations.length, 0);
  // Se activa: la siguiente actualizacion de stock lo publica donde falte
  DRAFTS.delete('gid://shopify/Product/2');
  res = await worker(sqsEvent([{ inventoryItemId: '2001' }]));
  assert.deepEqual(res, { batchItemFailures: [] });
  assert.deepEqual(calls.mutations.sort(), [
    ['add', 'gid://shopify/Publication/10', 'gid://shopify/Product/2'],
    ['add', 'gid://shopify/Publication/20', 'gid://shopify/Product/2'],
  ].sort());
  published['gid://shopify/Product/2'] = { 'gid://shopify/Publication/10': true, 'gid://shopify/Publication/20': true };
});

await check('mensaje con JSON roto aparece en batchItemFailures y el resto se procesa', async () => {
  const res = await worker(sqsEvent(['{roto', { inventoryItemId: '2001' }]));
  assert.deepEqual(res, { batchItemFailures: [{ itemIdentifier: 'm1' }] });
});

await check('item desconocido en Shopify no bloquea el lote', async () => {
  const res = await worker(sqsEvent([{ inventoryItemId: '9999' }]));
  assert.deepEqual(res, { batchItemFailures: [] });
});

await check('fallo de Shopify al procesar un producto -> sus mensajes vuelven a la cola', async () => {
  resetCaches();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/inventory_levels.json')) return new Response('{}', { status: 500 });
    return realFetch(url, init);
  };
  try {
    const res = await worker(sqsEvent([{ inventoryItemId: '1001' }, { inventoryItemId: '1002' }]));
    assert.deepEqual(res, { batchItemFailures: [{ itemIdentifier: 'm1' }, { itemIdentifier: 'm2' }] });
  } finally {
    globalThis.fetch = realFetch;
  }
});

console.log = realLog;
if (failures) {
  realLog(`\n${failures} prueba(s) fallida(s)`);
  process.exit(1);
}
realLog('\nTodo OK');

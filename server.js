// server.js
// Servidor local para pruebas manuales (no se despliega). Reproduce lo que
// hacen las dos Lambdas en un solo proceso: verifica la firma, agrupa los
// webhooks por producto con un retardo en memoria y lanza la sincronizacion.
// En AWS ese retardo lo pone la cola SQS (ver README).

import 'dotenv/config.js';
import express from 'express';
import morgan from 'morgan';
import { verifyShopifyHmac } from './src/hmac.mjs';
import { processBatch } from './src/sync.mjs';

const app = express();
app.disable('x-powered-by');
app.use(morgan('dev'));

// Body crudo en /webhooks: necesario para verificar la firma HMAC de Shopify
app.use('/webhooks', express.raw({ type: '*/*' }));
app.use(express.json());

const DEBOUNCE_MS = Number(process.env.DEBOUNCE_MS || 8000);
const CENTRAL = String(process.env.CENTRAL_LOCATION_ID || '').trim();
let pending = new Set();
let timer = null;

function enqueue(inventoryItemId) {
  pending.add(inventoryItemId);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    const lote = [...pending];
    pending = new Set();
    timer = null;
    processBatch(lote).catch((err) => console.error('Error procesando lote', err));
  }, DEBOUNCE_MS);
}

app.post('/webhooks/inventory_levels/update', (req, res) => {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: 'not_configured' });
  if (!verifyShopifyHmac(req.body, req.get('X-Shopify-Hmac-Sha256'), secret)) {
    return res.sendStatus(401);
  }
  let body;
  try {
    body = JSON.parse(req.body);
  } catch {
    return res.sendStatus(400);
  }
  res.sendStatus(200);
  const { inventory_item_id: itemId, location_id: locationId } = body || {};
  if (itemId && String(locationId) === CENTRAL) enqueue(String(itemId));
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Servidor local en http://localhost:${port}`));

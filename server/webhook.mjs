// server/webhook.mjs
// Receptor del webhook inventory_levels/update (API Gateway HTTP API, payload v2).
//
// Solo hace tres cosas, todas en milisegundos: verificar la firma de Shopify,
// descartar lo que no sea de la ubicacion central y encolar el inventory_item
// en SQS. Nada de Shopify aqui: Shopify exige el 2xx en menos de 5 s y el
// trabajo pesado lo hace el worker agrupado por producto.
//
// Falla en cerrado: sin SHOPIFY_WEBHOOK_SECRET responde 503 y no encola nada
// (en Render, sin secreto, se aceptaba todo).

import { verifyShopifyHmac } from '../src/hmac.mjs';
import { loadSecrets } from './secrets.mjs';

const WEBHOOK_PATH = '/webhooks/inventory_levels/update';

// Dependencias sustituibles en las pruebas (el cliente de SQS no se importa
// hasta la primera llamada real).
export const deps = {
  async sendToQueue(payload) {
    const { SQSClient, SendMessageCommand } = await import('@aws-sdk/client-sqs');
    deps.sqs ??= new SQSClient({});
    await deps.sqs.send(
      new SendMessageCommand({
        QueueUrl: process.env.QUEUE_URL,
        MessageBody: JSON.stringify(payload),
      })
    );
  },
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

export async function handler(event) {
  await loadSecrets();

  const method = event.requestContext?.http?.method || 'GET';
  const path = event.rawPath || '/';

  if (method === 'GET' && path === '/health') return json(200, { ok: true });
  if (path !== WEBHOOK_PATH) return json(404, { error: 'not_found' });
  if (method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('SHOPIFY_WEBHOOK_SECRET no configurado: webhook rechazado');
    return json(503, { error: 'not_configured' });
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64')
    : Buffer.from(event.body || '', 'utf8');
  const signature = event.headers?.['x-shopify-hmac-sha256'];
  if (!verifyShopifyHmac(rawBody, signature, secret)) return json(401, { error: 'bad_signature' });

  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return json(400, { error: 'bad_json' });
  }

  const { inventory_item_id: inventoryItemId, location_id: locationId } = body || {};
  const central = String(process.env.CENTRAL_LOCATION_ID || '').trim();

  if (!inventoryItemId || String(locationId) !== central) {
    return json(200, { ok: true, queued: false });
  }

  await deps.sendToQueue({
    inventoryItemId: String(inventoryItemId),
    locationId: String(locationId),
    receivedAt: new Date().toISOString(),
  });
  return json(200, { ok: true, queued: true });
}

// src/hmac.mjs
// Shopify firma el cuerpo crudo del webhook con el secreto de la app
// (cabecera X-Shopify-Hmac-Sha256, base64). Se compara en tiempo constante.
import crypto from 'node:crypto';

export function verifyShopifyHmac(rawBody, headerValue, secret) {
  if (!secret || !Buffer.isBuffer(rawBody)) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  const a = Buffer.from(digest);
  const b = Buffer.from(String(headerValue || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

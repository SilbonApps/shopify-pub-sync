// scripts/update-webhook.mjs
// Cambia la URL de la suscripcion INVENTORY_LEVELS_UPDATE de la app a la que
// se pase por argumento. Actualiza la suscripcion existente
// (webhookSubscriptionUpdate), no la borra ni la recrea, asi no hay hueco
// sin webhook. Imprime antes y despues.
//
//   node scripts/update-webhook.mjs https://<api>.execute-api.eu-central-1.amazonaws.com/webhooks/inventory_levels/update
//
// Credenciales: SHOP_DOMAIN y SHOPIFY_ADMIN_TOKEN del entorno, o de SSM si
// SECRETS_SSM_PREFIX esta definida (p. ej. /silbon/pub-sync).

import { loadSecrets } from '../server/secrets.mjs';
import { shopifyGraphQL } from '../src/shopify.mjs';

const newUrl = process.argv[2];
if (!newUrl || !/^https:\/\/.+\/webhooks\/inventory_levels\/update$/.test(newUrl)) {
  console.error('Uso: node scripts/update-webhook.mjs https://<host>/webhooks/inventory_levels/update');
  process.exit(1);
}

await loadSecrets();

const listQuery = `
  query {
    webhookSubscriptions(first: 20, topics: [INVENTORY_LEVELS_UPDATE]) {
      nodes {
        id
        topic
        endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } }
      }
    }
  }
`;
const { data } = await shopifyGraphQL(listQuery);
const subs = (data?.webhookSubscriptions?.nodes || []).filter(
  (s) => s.endpoint?.__typename === 'WebhookHttpEndpoint'
);

if (!subs.length) {
  console.error('La app no tiene ninguna suscripcion INVENTORY_LEVELS_UPDATE. Crea una con webhookSubscriptionCreate.');
  process.exit(2);
}

console.log('Antes:');
for (const s of subs) console.log(`  ${s.id}  ${s.endpoint.callbackUrl}`);

const mutation = `
  mutation($id: ID!, $url: URL!) {
    webhookSubscriptionUpdate(id: $id, webhookSubscription: { callbackUrl: $url }) {
      webhookSubscription { id endpoint { ... on WebhookHttpEndpoint { callbackUrl } } }
      userErrors { field message }
    }
  }
`;

for (const s of subs) {
  if (s.endpoint.callbackUrl === newUrl) {
    console.log(`  ${s.id} ya apunta a la URL nueva`);
    continue;
  }
  const res = await shopifyGraphQL(mutation, { id: s.id, url: newUrl });
  const errs = res.data?.webhookSubscriptionUpdate?.userErrors || [];
  if (errs.length) {
    console.error(`  ${s.id} userErrors:`, JSON.stringify(errs));
    process.exit(3);
  }
}

const after = await shopifyGraphQL(listQuery);
console.log('Despues:');
for (const s of after.data?.webhookSubscriptions?.nodes || []) {
  console.log(`  ${s.id}  ${s.endpoint?.callbackUrl}`);
}

// server/worker.mjs
// Consumidor de la cola SQS. Recibe lotes de hasta 10 mensajes (que llegan
// juntos gracias al retardo de la cola y a la ventana de agrupacion del
// mapping), los agrupa por producto y hace UNA pasada por producto.
//
// Con ReportBatchItemFailures solo vuelven a la cola los mensajes que han
// fallado; el resto se borran. Tras los reintentos configurados en la cola
// acaban en la cola de mensajes muertos.

import { processBatch } from '../src/sync.mjs';
import { loadSecrets } from './secrets.mjs';

export async function handler(event) {
  await loadSecrets();

  const records = event.Records || [];
  const batchItemFailures = [];
  const itemByMessage = new Map(); // messageId -> inventoryItemId

  for (const record of records) {
    try {
      const body = JSON.parse(record.body);
      const itemId = String(body?.inventoryItemId || '');
      if (!itemId) throw new Error('mensaje sin inventoryItemId');
      itemByMessage.set(record.messageId, itemId);
    } catch (error) {
      console.error('Mensaje ilegible', record.messageId, error.message);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  const itemIds = [...itemByMessage.values()];
  console.log(`Lote: ${records.length} mensajes, ${new Set(itemIds).size} inventory items`);

  if (itemIds.length) {
    const results = await processBatch(itemIds);
    for (const [messageId, itemId] of itemByMessage) {
      const outcome = results.get(itemId);
      if (!outcome || !outcome.ok) batchItemFailures.push({ itemIdentifier: messageId });
    }
  }

  if (batchItemFailures.length) {
    console.warn(`Fallos parciales: ${batchItemFailures.length} de ${records.length}`);
  }
  return { batchItemFailures };
}

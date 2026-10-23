# shopify-pub-sync

Publica o despublica productos en **Shopify Markets** según el stock de la **ubicación central**.

Cuando cambia el inventario (webhook `inventory_levels/update`):

- Si **todas las variantes** del producto tienen `0` en la central → se **despublica** de los Markets configurados.
- Si **alguna** tiene stock → se **publica** en esos Markets.

Desplegado en AWS Lambda (cuenta de Silbon, eu-central-1). Ver [Despliegue en AWS](#despliegue-en-aws).

> **Repositorio privado.** Contiene lógica de integración y referencias a la configuración de producción.

---

## Cómo funciona

```
Shopify ──POST /webhooks/inventory_levels/update──▶ Lambda receptor ──▶ cola SQS (retardo 8 s) ──▶ Lambda worker
                                                   (firma HMAC,        (debounce)                 (agrupa por producto,
                                                    ¿ubicación central?)                            consulta stock, sincroniza Markets)
```

1. **Receptor** (`server/webhook.mjs`). Verifica la firma de Shopify sobre el cuerpo crudo, descarta lo que no sea de `CENTRAL_LOCATION_ID` y encola `{ inventoryItemId }`. No toca Shopify: responde en milisegundos (Shopify exige el 2xx en menos de 5 s).
2. **Cola SQS** con `DelaySeconds` (8 por defecto). Es el *debounce*: los webhooks de un mismo producto que llegan en ráfaga (una venta con varias tallas, una carga de stock) se entregan juntos al worker.
3. **Worker** (`server/worker.mjs`). Recibe lotes de hasta 10 mensajes, deduplica por `inventory_item_id`, resuelve el producto de cada uno (una consulta GraphQL, con caché de contenedor), deduplica por producto y hace **una pasada por producto**: stock de todas sus variantes en la central (REST `inventory_levels`), `allZero`, y `syncMarkets`.
4. **`syncMarkets`** (`src/marketSync.mjs`) consulta primero si el producto ya está publicado en cada Market (`publishedOnPublication`, una sola consulta) y **solo muta lo que difiere**. Por eso la operación es idempotente: un webhook repetido, un reintento de SQS o un contenedor sin caché no generan mutaciones de más.

### Qué garantiza y qué no

- Un cambio de stock en la central acaba reflejado en los Markets en unos 10-20 s (retardo de la cola + ventana de agrupación + proceso).
- Si Shopify falla al procesar un producto, **solo sus mensajes** vuelven a la cola (`ReportBatchItemFailures`); tras 3 intentos van a la **cola de mensajes muertos** (`silbon-pub-sync-dlq`, 14 días). Los demás mensajes del lote se procesan.
- El worker tiene concurrencia reservada 2: como mucho dos lotes a la vez contra la Admin API.
- Sin `SHOPIFY_WEBHOOK_SECRET` el receptor responde 503 y no encola nada (**falla en cerrado**; en Render, sin secreto, se aceptaba todo).

### Ver la cola de mensajes muertos

```powershell
aws sqs get-queue-attributes --queue-url (aws sqs get-queue-url --queue-name silbon-pub-sync-dlq --query QueueUrl --output text --region eu-central-1) --attribute-names ApproximateNumberOfMessages --region eu-central-1
aws sqs receive-message --queue-url <url de la DLQ> --max-number-of-messages 10 --region eu-central-1
```

Para reprocesar la DLQ: consola de SQS → cola `silbon-pub-sync-dlq` → *Start DLQ redrive* hacia `silbon-pub-sync-queue`.

---

## Variables de entorno

| Variable | Dónde | Para qué |
|---|---|---|
| `SHOPIFY_ADMIN_TOKEN` | SSM `/silbon/pub-sync/SHOPIFY_ADMIN_TOKEN` | Admin API (GraphQL + REST) |
| `SHOPIFY_WEBHOOK_SECRET` | SSM `/silbon/pub-sync/SHOPIFY_WEBHOOK_SECRET` | Firma HMAC de los webhooks de la app |
| `SHOP_DOMAIN` | Parámetro de la pila | `silbon-store.myshopify.com` |
| `CENTRAL_LOCATION_ID` | Parámetro de la pila | ID numérico de la ubicación central |
| `MARKET_IDS` | Parámetro de la pila | GIDs de los Markets, separados por comas |
| `DEBOUNCE_MS` | Solo servidor local | Retardo en memoria (en AWS lo pone la cola) |

`server/secrets.mjs` carga los dos secretos de SSM en `process.env` al arrancar la Lambda. En local se leen de `.env`.

---

## Despliegue en AWS

Mismo patrón que el resto de pilas de Silbon: CloudFormation desplegado con el AWS CLI, sin SAM, secretos en SSM Parameter Store y un `deploy.ps1`.

| Pieza | Dónde |
|---|---|
| Pila `silbon-pub-sync` | `aws/template.yaml` (colas, roles, dos Lambdas, mapping SQS, HTTP API, dominio opcional) |
| Receptor | Lambda `silbon-pub-sync-webhook` (`server/webhook.handler`) tras API Gateway HTTP |
| Worker | Lambda `silbon-pub-sync-worker` (`server/worker.handler`) consumiendo `silbon-pub-sync-queue` |
| Secretos | SSM `/silbon/pub-sync/` |

Primera vez: crear los secretos (el script dice cuáles faltan) y desplegar:

```powershell
aws ssm put-parameter --name /silbon/pub-sync/SHOPIFY_ADMIN_TOKEN --type SecureString --value '<valor>' --region eu-central-1
aws ssm put-parameter --name /silbon/pub-sync/SHOPIFY_WEBHOOK_SECRET --type SecureString --value '<valor>' --region eu-central-1

npm run aws:deploy -- -ShopDomain silbon-store.myshopify.com -CentralLocationId <id> -MarketIds "gid://shopify/Market/...,gid://shopify/Market/..."
```

`-SkipStack` solo sube el código. Con `-DomainName pub-sync.silbon.es -CertificateArn arn:aws:acm:eu-central-1:...` la pila crea el dominio propio (certificado ACM regional, no en us-east-1) y el alias en Route53.

El script imprime la **URL del webhook**. La primera vez, o si cambia, hay que apuntar ahí la suscripción `inventory_levels/update` de la app en Shopify. Se actualiza en sitio (no se borra ni se recrea, así no hay hueco sin webhook):

```powershell
$env:SECRETS_SSM_PREFIX='/silbon/pub-sync'; $env:SHOP_DOMAIN='silbon-store.myshopify.com'
npm run update-webhook -- https://<api>.execute-api.eu-central-1.amazonaws.com/webhooks/inventory_levels/update
```

Logs: `/aws/lambda/silbon-pub-sync-webhook` y `/aws/lambda/silbon-pub-sync-worker` en CloudWatch (30 días).

---

## Probar en local

- `npm run test:lambda`: invoca los dos handlers con eventos sintéticos de API Gateway y SQS, sin red (Shopify y SQS simulados). Cubre firma, ubicación, encolado, agrupación por producto, idempotencia y fallos parciales.
- `npm run dev`: servidor Express local (`server.js`) que reproduce el flujo en un solo proceso con el retardo en memoria. Necesita `.env` con las variables de arriba.

---

Autor: Javier García-Rojo Cantón — Lead Developer, Silbon

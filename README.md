# shopify-pub-sync

Servicio backend Node.js que **sincroniza la publicación de productos en Shopify Markets** según el stock disponible en la **ubicación central**.

Cuando el inventario cambia (webhook `inventory_levels/update`):
- Si **todas las variantes** del producto tienen stock `0` en la central → se **despublica** de los Markets configurados.  
- Si hay **cualquier stock disponible** → se **publica** automáticamente en esos Markets.

---

## ⚙️ Funcionalidad principal

**Ruta webhook:**  
`POST /webhooks/inventory_levels/update`

1. Shopify envía el webhook al cambiar un nivel de inventario.  
2. El servicio comprueba si el cambio pertenece a la ubicación central (`CENTRAL_LOCATION_ID`).  
3. Obtiene el producto completo y el `available` de todas sus variantes vía REST.  
4. Calcula el flag `allZero` (true si todo está a 0).  
5. Llama a `syncMarkets(productId, allZero)` para publicar o despublicar el producto.

Ejemplo de log:

{
productId: 'gid://shopify/Product/15193445106041',
productTitle: 'Cazadora clasica azul marino',
allZero: false
}
syncMarkets() {
productGid: 'gid://shopify/Product/15193445106041',
allZero: false,
marketIds: [
'gid://shopify/Market/69722177814',
'gid://shopify/Market/63495340310',
'gid://shopify/Market/63495373078'
]
}
✅ Published to market gid://shopify/Market/69722177814 []
✅ Published to market gid://shopify/Market/63495340310 []
✅ Published to market gid://shopify/Market/63495373078 []


## 🚀 Despliegue

- Plataforma: **Render** (Web Service)
- Build Command: `npm install`
- Start Command: `node server.js`
- Webhook Shopify → `https://<service>.onrender.com/webhooks/inventory_levels/update`
- Logs accesibles en Render → *Events*

---

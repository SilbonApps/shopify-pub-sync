// agent.js — agente HTTPS compartido con keep-alive para reutilizar conexiones TLS con Shopify
import https from "node:https";

export const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 20 });

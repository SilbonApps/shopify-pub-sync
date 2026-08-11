import "dotenv/config.js";
import express from "express";
import morgan from "morgan";
import webhooks from "./webhooks.js";

const app = express();
app.disable("x-powered-by");
app.use(morgan("dev"));

// Body crudo en /webhooks: necesario para verificar la firma HMAC de Shopify
app.use("/webhooks", express.raw({ type: "*/*" }));
app.use(express.json());

app.use("/", webhooks);

app.get("/health", (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🚀 Server running on http://localhost:${port}`));

import "dotenv/config.js";
import express from "express";
import morgan from "morgan";
import webhooks from "./webhooks.js";

const app = express();
app.use(morgan("dev"));
app.use(express.json()); // importante

app.use("/", webhooks);

app.get("/health", (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🚀 Server running on http://localhost:${port}`));

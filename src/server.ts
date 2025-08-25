import http from "http";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import "dotenv/config";
import { runAgent } from "./pipeline.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, "../public");
const PORT = Number(process.env.PORT || 3000);

function contentTypeFor(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".html") return "text/html; charset=UTF-8";
    if (ext === ".js") return "text/javascript; charset=UTF-8";
    if (ext === ".css") return "text/css; charset=UTF-8";
    if (ext === ".json") return "application/json; charset=UTF-8";
    return "text/plain; charset=UTF-8";
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
    let urlPath = req.url || "/";
    if (urlPath === "/") urlPath = "/index.html";
    const filePath = path.join(PUBLIC_DIR, urlPath);
    try {
        const data = await fs.readFile(filePath);
        res.writeHead(200, { "Content-Type": contentTypeFor(filePath) });
        res.end(data);
    } catch {
        res.writeHead(404, { "Content-Type": "text/plain; charset=UTF-8" });
        res.end("Not found");
    }
}

async function handleAsk(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
        const body = Buffer.concat(chunks).toString("utf8");
        const parsed = JSON.parse(body || "{}");
        const question = String(parsed.question || "").trim();
        if (!question) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing 'question'" }));
            return;
        }
        const { trace } = await runAgent(question);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ trace }));
    } catch (e: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e?.message || String(e) }));
    }
}

const server = http.createServer(async (req, res) => {
    const method = req.method || "GET";
    const url = req.url || "/";
    if (method === "POST" && url === "/api/ask") {
        await handleAsk(req, res);
        return;
    }
    if (method === "GET") {
        await serveStatic(req, res);
        return;
    }
    res.writeHead(405, { "Content-Type": "text/plain; charset=UTF-8" });
    res.end("Method Not Allowed");
});

server.listen(PORT, () => {
    console.log(`Web UI listening on http://localhost:${PORT}`);
});



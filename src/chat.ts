import readline from "node:readline";
import "dotenv/config";
import { runAgent } from "./pipeline.js";

function printHelp() {
    console.log("Commands: /exit to quit, /help to show this message");
}

async function main() {
    console.log("Agentic RAG Chat. Type your question and press Enter. (/help for help)");

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "Q> " });
    rl.prompt();

    rl.on("line", async (line: string) => {
        const q = line.trim();
        if (q.length === 0) {
            rl.prompt();
            return;
        }
        if (q === "/exit") {
            rl.close();
            return;
        }
        if (q === "/help") {
            printHelp();
            rl.prompt();
            return;
        }
        try {
            const { trace } = await runAgent(q);
            console.log("\n=== ANSWER ===\n" + trace.answer);
            console.log("\n=== METRICS ===");
            console.table({
                plan: trace.plan,
                ttft_ms: Math.round(trace.ttft_ms),
                toks_per_s: Math.round(trace.toks_per_s * 10) / 10,
                retrieval_ms: Math.round(trace.retrieval.took_ms),
                agent_overhead_ms: Math.round(trace.total_ms - trace.retrieval.took_ms),
                claims: trace.verify.claims,
                supported: trace.verify.supported,
                attrP: Math.round(trace.verify.p * 100) / 100,
            });
            console.log("Citations:", trace.retrieval.ids.join(", "));
        } catch (e: any) {
            console.error("Error:", e?.message || e);
        }
        rl.prompt();
    });

    rl.on("close", () => {
        console.log("\nBye");
        process.exit(0);
    });
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});



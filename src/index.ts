import { runAgent } from "./agent/runAgent.js";

function formatErrorForLog(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return Object.prototype.toString.call(error);
  }
}

async function main(): Promise<void> {
  const input =
    process.argv.slice(2).join(" ").trim() ||
    "¿Cuánto es el 25% de 240 y qué hora es ahora?";

  const output = await runAgent(input, { verbose: true });
  console.log("\nRespuesta del agente:\n");
  console.log(output);
}

main().catch((error: unknown) => {
  // Avoid passing arbitrary thrown values as extra console.error args: Node's
  // util.inspect can throw on some library error shapes (e.g. Node 24 + fetch/API errors).
  console.error(`Error ejecutando el agente:\n${formatErrorForLog(error)}`);
  process.exit(1);
});

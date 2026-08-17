import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = buildApp(config);

const close = async (): Promise<void> => {
  await app.close();
};

process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());

await app.listen({ host: config.host, port: config.port });

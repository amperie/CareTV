import Fastify from "fastify";

import { loadConfig } from "@caretv/config";
import { createHealthStatus } from "@caretv/core";

const config = loadConfig();

const app = Fastify({ logger: true });

app.get("/health", () => createHealthStatus("server"));

try {
  app.log.info({ config: config.redacted }, "Loaded CareTV configuration");
  await app.listen({ host: config.values.host, port: config.values.serverPort });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

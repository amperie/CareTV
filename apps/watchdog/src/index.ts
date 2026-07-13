import { createHealthStatus } from "@caretv/core";

const status = createHealthStatus("watchdog");

console.log(JSON.stringify(status));

import { createHealthStatus } from "@caretv/core";

const status = createHealthStatus("agent");

console.log(JSON.stringify(status));

import { resolveConfig } from "./src/config.js";
import { createLobsterAiRuntime } from "./src/runtime.js";

const plugin = {
  id: "lobsterai-otel-plugin",
  name: "LobsterAI OpenTelemetry",
  description: "Export terminal LobsterAI turns as GTrace-compatible OTLP traces and metrics",
  register(api) {
    const config = resolveConfig(api.pluginConfig, process.env);
    if (!config.enabled) {
      api.logger.info("[lobsterai-otel] disabled by config; no hooks or state access started");
      return;
    }

    const runtime = createLobsterAiRuntime({ config, logger: api.logger });
    runtime.registerHooks(api);
    api.registerService({
      id: "lobsterai-otel-plugin",
      async start(ctx) {
        await runtime.start(ctx.stateDir);
      },
      async stop() {
        await runtime.stop();
      }
    });
  }
};

export default plugin;

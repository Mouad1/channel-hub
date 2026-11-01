import { builtInConnectors } from "./connectors/index.js";
import { Hub } from "./core/hub.js";
import { loadEnv, type Env } from "./env.js";

/** One Hub configured from the environment, plus where it listens. */
export function createRuntime(processEnv: Env = process.env) {
  const { env, home, port } = loadEnv(processEnv);
  let actualPort = port;
  const hub = new Hub({ home, env, connectors: builtInConnectors(env), baseUrl: () => `http://127.0.0.1:${actualPort}` });
  return { env, home, port, hub, setPort: (p: number) => (actualPort = p) };
}

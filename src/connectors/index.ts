import type { Connector } from "../core/types.js";
import type { Env } from "../env.js";
import { youtubeConnector } from "./youtube/index.js";

/** The connectors this Hub ships with. Add yours here (see CONNECTORS.md). */
export function builtInConnectors(env: Env): Connector[] {
  return [youtubeConnector({ googleBaseUrl: env.CHANNEL_HUB_TEST_GOOGLE_BASE_URL })];
}

#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ChannelHubClient, ChannelHubError } from "./client.js";
import { createRuntime } from "./runtime.js";
import { startServer } from "./server.js";

// Like Flow Studio: this process serves the Hub itself when the port is free, else it talks to the Hub that runs.
const rt = createRuntime();
const running = await startServer(rt.hub, { home: rt.home, port: rt.port, onListen: rt.setPort });
if (running.role === "none") process.stderr.write(`channel-hub: port ${rt.port} is used by another program; set CHANNEL_HUB_PORT.\n`);
const url = `http://127.0.0.1:${running.port}`;

let client: ChannelHubClient | undefined;
let setupProblem: string | undefined;
try {
  client = new ChannelHubClient({ url, key: rt.env.CHANNEL_HUB_KEY });
} catch (err) {
  setupProblem = err instanceof Error ? err.message : String(err);
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const reply = async (work: (hub: ChannelHubClient) => Promise<unknown>): Promise<ToolResult> => {
  try {
    if (!client) throw new ChannelHubError("not_configured", `${setupProblem} Add it to this MCP server's env.`, 0);
    return { content: [{ type: "text", text: JSON.stringify(await work(client), null, 2) }] };
  } catch (err) {
    const body = err instanceof ChannelHubError ? { error: err.code, message: err.message } : { error: "error", message: err instanceof Error ? err.message : String(err) };
    return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }], isError: true };
  }
};

const visibility = z.enum(["private", "unlisted", "public"]);
const account = z.string().describe('Account id from accounts_list, e.g. "youtube:UC..."');
const captions = { file_path: z.string().describe("Absolute path to a captions file (.srt, .vtt)"), language: z.string().describe("Language code, e.g. en, fr"), name: z.string().optional().describe("Track name shown to viewers") };

const server = new McpServer({ name: "channel-hub", version: "0.1.0" });

server.registerTool(
  "accounts_list",
  {
    title: "List publishing accounts",
    description: "Accounts (e.g. YouTube channels) this assistant may publish to, with what each can do and whether it must be reconnected. Call this first.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  () => reply((hub) => hub.accounts()),
);

server.registerTool(
  "video_upload",
  {
    title: "Upload a video",
    description:
      "Upload a local video file to an account. Private unless visibility says otherwise; public also needs confirm_public: true, which only the user may decide. " +
      "The same file is never uploaded twice to one account: a finished upload returns its link. Returns a publish_id at once; poll video_status for the result. " +
      "If an earlier upload has an unknown outcome, ask the user to check the platform before sending retry_unknown: true. " +
      "YouTube options: made_for_kids (required), ai_label (required; marks altered or synthetic content), language, category_id.",
    inputSchema: {
      account,
      file_path: z.string().describe("Absolute path to the video file on this machine"),
      title: z.string(),
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      visibility: visibility.optional().describe("Default private"),
      confirm_public: z.boolean().optional().describe("Required for public; only when the user explicitly asked for public"),
      options: z.record(z.string(), z.unknown()).optional().describe("Platform options, e.g. YouTube { made_for_kids, ai_label, language }"),
      captions: z.object(captions).optional().describe("Captions to add once the video is up; a captions failure never removes the video"),
      retry_unknown: z.boolean().optional().describe("Only after the user confirmed an earlier unknown upload is not on the platform"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  (args) => reply((hub) => hub.publish(args)),
);

server.registerTool(
  "video_status",
  {
    title: "Video status",
    description: "With publish_id: the Hub's record of an upload (uploading, published, failed, unknown) with its link. With account + external_id: the platform's own status (visibility, processing).",
    inputSchema: { publish_id: z.string().optional(), account: account.optional(), external_id: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  (args) =>
    reply(async (hub) => {
      if (args.publish_id) return hub.publishStatus(args.publish_id);
      if (args.account && args.external_id) return hub.postStatus(args.account, args.external_id);
      throw new ChannelHubError("invalid_input", "Give publish_id, or account and external_id.", 400);
    }),
);

server.registerTool(
  "captions_upload",
  {
    title: "Upload captions",
    description: "Add a captions track to a video already on the platform (for example after a captions failure, once the account is reconnected).",
    inputSchema: { account, external_id: z.string(), ...captions },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  ({ account: id, external_id, ...rest }) => reply((hub) => hub.captions(id, external_id, rest)),
);

server.registerTool(
  "video_update",
  {
    title: "Change video visibility",
    description: "Change who can see a video: private, unlisted or public. Public needs confirm_public: true, only when the user explicitly asked for it.",
    inputSchema: { account, external_id: z.string(), visibility, confirm_public: z.boolean().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  (args) => reply((hub) => hub.setVisibility(args.account, args.external_id, args.visibility, args.confirm_public === true)),
);

await server.connect(new StdioServerTransport());

// When the assistant closes or stops this process, give running uploads up to a minute to finish. One that is cut off
// is recorded as unknown on restart and is never retried by itself.
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await rt.hub.idle(60_000);
  if (running.role === "owner") await running.close();
  process.exit(0);
};
process.stdin.on("close", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

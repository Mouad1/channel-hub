import { z } from "zod";
import { ConnectorError } from "../dist/core/types.js";

/**
 * A minimal connector that lives only in tests. It proves core works for any platform: nothing in core names it.
 * `script` decides what the next calls do: "ok", "fail" (a clear platform refusal), "drop" (connection lost mid-upload),
 * "permission" (missing scope), or a Promise to wait on (keeps an upload running).
 */
export function fakeConnector() {
  const calls = [];
  const script = { upload: [], captions: [] };
  let n = 0;
  const next = async (kind) => {
    const step = script[kind].shift() ?? "ok";
    if (step instanceof Promise) await step;
    if (step === "fail") throw new ConnectorError("invalid", `${kind} refused by platform`, 400);
    if (step === "drop") throw new TypeError("fetch failed");
    if (step === "permission") throw new ConnectorError("permission", "missing scope", 403);
  };
  return {
    calls,
    script,
    connector: {
      id: "fake",
      name: "Fake",
      credentials: [],
      auth: { kind: "api_key", label: "Fake key" },
      capabilities: ["video.upload", "captions.upload", "video.status", "video.visibility"],
      visibilities: ["private", "public"],
      limits: { title: 50, description: 200, tags: 5, extensions: [".mp4"], maxBytes: 1024, captionsExtensions: [".srt"] },
      options: z.object({ note: z.string().max(10).optional() }).strict(),
      async account(ctx) {
        calls.push(["account", ctx.accessToken]);
        if (ctx.accessToken === "bad") throw new ConnectorError("authorization", "bad key", 401);
        const id = { k1: "alpha", k2: "beta" }[ctx.accessToken] ?? "other";
        return { externalId: id, name: `Fake ${id}` };
      },
      async upload(ctx, input) {
        calls.push(["upload", ctx.accessToken, input]);
        await next("upload");
        const id = `v${++n}`;
        return { externalId: id, url: `https://fake.example/${id}` };
      },
      async captions(ctx, input) {
        calls.push(["captions", ctx.accessToken, input]);
        await next("captions");
        return { captionId: `c-${input.externalId}` };
      },
      async status(_ctx, externalId) {
        calls.push(["status", externalId]);
        return { state: "processed", visibility: "private", url: `https://fake.example/${externalId}` };
      },
      async setVisibility(_ctx, externalId, visibility) {
        calls.push(["setVisibility", externalId, visibility]);
      },
    },
  };
}

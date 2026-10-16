import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import plugin from "../src/index";
import type { Plugin } from "@opencode/plugin";

const directory = join(import.meta.dir, "../.fixtures");
const local = join(directory, "local.json");
const envKeys = ["OPENCODE_RESIDENCY_CONFIG_FILE", "OPENCODE_RESIDENCY_DEBUG", "OPENCODE_RESIDENCY_DEBUG_FILE", "OPENCODE_CODEX_REASONING"];
let saved: (string | undefined)[];
beforeEach(() => {
  saved = envKeys.map(key => process.env[key]);
  mkdirSync(directory, { recursive: true });
  writeFileSync(local, "{}");
  process.env.OPENCODE_RESIDENCY_CONFIG_FILE = local;
  delete process.env.OPENCODE_RESIDENCY_DEBUG;
});
afterEach(() => {
  envKeys.forEach((key, index) => {
    if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index];
  });
  rmSync(directory, { recursive: true, force: true });
});

// Mock only public context I/O. Invoke the real setup and every registered
// callback; scope dispatch and disposal model the host's ownership contract.
async function host(options: Record<string, Record<string, unknown>>, aliases: Record<string, string> = {}, definition = plugin) {
  const hooks: { name: string; run: (event: any) => Promise<void>; providerID: string }[] = [];
  const context = {
    provider: {
      list: async () => ({ data: Object.keys(options).map(id => ({ id })) }),
      get: async ({ providerID }: { providerID: string }) => ({ data: { settings: options[providerID] } }),
    },
    model: { list: async () => ({ data: Object.keys(options).flatMap(providerID =>
      Object.entries(aliases).map(([id, modelID]) => ({ providerID, id, modelID }))) }) },
    session: { hook: async (name: string, run: any, scope: { providerID: string }) => {
      const registration = { name, run, providerID: scope.providerID };
      hooks.push(registration);
      return { dispose: async () => { hooks.splice(hooks.indexOf(registration), 1); } };
    } },
  };
  const cleanup = await definition.setup(context as unknown as Plugin.Context);
  return {
    hooks,
    run: async (name: string, event: any) => {
      for (const hook of hooks) if (hook.name === name && hook.providerID === event.model.providerID) await hook.run(event);
      return event;
    },
    unload: async () => { await cleanup?.(); hooks.length = 0; },
    cleanup,
  };
}
function event(providerID = "openai", id = "gpt-5.5", kind = "primary") {
  return { sessionID: "fixture", agent: "fixture", model: { providerID, id }, kind };
}
function request(model: string, url = "https://api.openai.com/v1/responses") {
  return new Request(url, {
    method: "POST", body: JSON.stringify({ model, stream: true, input: "fixture-only" }),
    headers: { Authorization: "Bearer fixture-not-a-secret", "X-Preserve": "yes", "User-Agent": "old", Originator: "old" },
  });
}

test("import and setup do not patch fetch, default providers stay untouched", async () => {
  const fetch = globalThis.fetch;
  const h = await host({ openai: {}, anthropic: {} });
  expect(globalThis.fetch).toBe(fetch);
  expect(h.hooks.filter(hook => hook.name === "http.request")).toHaveLength(0);
  const e = await h.run("model.request", { ...event(), headers: { "X-Preserve": "yes" } });
  expect(e.headers["user-agent"]).toBeUndefined();
  expect(e.headers["x-preserve"]).toBe("yes");
  await h.unload();
});

for (const kind of ["primary", "title", "generate", "compaction"]) {
  test(`${kind}: real model and HTTP hooks preserve auth/body/identity and set residency/UA`, async () => {
    const h = await host({ openai: { transport: "http", enforce_residency: "us", ua_override: true, ua_version: "12.34" } });
    const semantic = await h.run("model.request", { ...event("openai", "gpt-5.5", kind), headers: { "X-Preserve": "yes" } });
    expect(semantic.headers["x-openai-internal-codex-residency"]).toBe("us");
    const input = request("gpt-5.5");
    const e = await h.run("http.request", { ...event("openai", "gpt-5.5", kind), request: input });
    expect(e.request.headers.get("user-agent")).toContain("codex_cli_rs/12.34");
    expect(e.request.headers.get("originator")).toBe("codex_cli_rs");
    expect(e.request.headers.get("authorization")).toBe("Bearer fixture-not-a-secret");
    expect(e.request.headers.get("x-preserve")).toBe("yes");
    expect(e.request.url).toBe(input.url);
    expect(await e.request.json()).toEqual({ model: "gpt-5.5", stream: true, input: "fixture-only" });
    await h.unload();
  });
}

test("provider isolation: settings, targets, residency and UA do not leak across interleaved requests", async () => {
  const h = await host({ a: { ua_override: true, baseURL: "https://a.invalid/v1", ua_string: "client-a", enforce_residency: "eu" }, b: { ua_override: true, baseURL: "https://b.invalid/v1", ua_string: "client-b" }, off: {} });
  for (const provider of ["a", "b", "a"]) {
    const e = await h.run("http.request", { ...event(provider), request: request("gpt-x", `https://${provider}.invalid/v1/responses`) });
    expect(e.request.headers.get("user-agent")).toBe(`client-${provider}`);
    expect(e.request.headers.get("x-openai-internal-codex-residency")).toBe(provider === "a" ? "eu" : null);
  }
  const other = await h.run("http.request", { ...event("b"), request: request("gpt-x", "https://a.invalid/v1/responses") });
  expect(other.request.headers.get("user-agent")).toBe("old");
  const off = request("gpt-x");
  expect((await h.run("http.request", { ...event("off"), request: off })).request).toBe(off);
  await h.unload();
});

test("local precedence and live reload; local residency ignored; Claude beta preserves query and body", async () => {
  writeFileSync(local, JSON.stringify({ ua_override: true, ua_gpt_models: true, ua_string: "local", enforce_residency: "ignored", claude_ua_string: "claude-custom", ua_target_fragments: ["proxy.invalid"] }));
  const h = await host({ gateway: { ua_string: "provider" } });
  let e = await h.run("http.request", { ...event("gateway"), request: request("gpt-x", "https://other.invalid/responses") });
  expect(e.request.headers.get("user-agent")).toBe("local");
  expect(e.request.headers.get("x-openai-internal-codex-residency")).toBeNull();
  e = await h.run("http.request", { ...event("gateway", "claude-x"), request: request("claude-x", "https://proxy.invalid/messages?keep=1&beta=false") });
  expect(e.request.headers.get("user-agent")).toBe("claude-custom");
  expect(e.request.headers.has("originator")).toBe(false);
  expect(new URL(e.request.url).searchParams.get("keep")).toBe("1");
  expect(new URL(e.request.url).searchParams.get("beta")).toBe("true");
  writeFileSync(local, JSON.stringify({ ua_string: "changed", ua_override: true, ua_gpt_models: true }));
  e = await h.run("http.request", { ...event("gateway"), request: request("gpt-x", "https://other.invalid/responses") });
  expect(e.request.headers.get("user-agent")).toBe("changed");
  await h.unload();
});

test("WS requires explicit native transport instead of silently expanding routing", async () => {
  await expect(host({ openai: { ws_transport: true } })).rejects.toThrow('settings.transport="websocket"');
});

test("default native providers retain their host-selected transport with UA enabled", async () => {
  const h = await host({ openai: { ua_override: true }, azure: { ua_override: true }, xai: { ua_override: true } });
  expect(h.hooks.some(hook => hook.name === "http.request")).toBe(false);
  const e = await h.run("model.request", { ...event(), headers: { "User-Agent": "old" }, baseURL: "https://api.openai.com/v1" });
  expect(e.headers["user-agent"]).toContain("codex_cli_rs/");
  expect(e.baseURL).toBe("https://api.openai.com/v1");
  await h.unload();
});

test("changed transport and newly enabled HTTP UA require setup again", async () => {
  const options = { openai: { transport: "http", ua_override: false } };
  const h = await host(options);
  options.openai.ua_override = true;
  await expect(h.run("model.request", { ...event(), headers: {} })).rejects.toThrow("reload the plugin");
  options.openai.ua_override = false;
  options.openai.transport = "websocket";
  await expect(h.run("model.request", { ...event(), headers: {} })).rejects.toThrow("reload the plugin");
  await h.unload();
});

test("malformed local JSON diagnostics contain no file contents, URLs, prompts or credentials", async () => {
  const log = join(directory, "debug.log");
  process.env.OPENCODE_RESIDENCY_DEBUG = "1";
  process.env.OPENCODE_RESIDENCY_DEBUG_FILE = log;
  writeFileSync(local, 'fixture-secret-malformed');
  const h = await host({ openai: {} });
  const text = await Bun.file(log).text();
  expect(text).toContain("local configuration unavailable");
  expect(text).not.toContain("fixture-secret");
  expect(text).not.toContain(local);
  await h.unload();
});

test("compressed HTTP bodies are preserved and use upstream alias identity", async () => {
  const h = await host({ gateway: { ua_override: true, baseURL: "https://gateway.invalid/v1" } }, { alias: "claude-fixture" });
  const bytes = new Uint8Array([1, 2, 3]);
  const input = new Request("https://gateway.invalid/v1/messages", { method: "POST", body: bytes, headers: { "Content-Encoding": "gzip", Authorization: "Bearer fixture" } });
  const e = await h.run("http.request", { ...event("gateway", "alias"), request: input });
  expect(e.request.headers.get("user-agent")).toContain("claude-cli/");
  expect(e.request.headers.get("authorization")).toBe("Bearer fixture");
  expect(new Uint8Array(await e.request.arrayBuffer())).toEqual(bytes);
  expect(new URL(e.request.url).searchParams.get("beta")).toBe("true");
  await h.unload();
});

test("built entrypoint registers functioning V2 hooks, not a V1 dictionary", async () => {
  const built = (await import("../dist/index.js")).default;
  const h = await host({ openai: { enforce_residency: "us" } }, {}, built);
  const e = await h.run("model.request", { ...event(), headers: { "x-preserve": "yes" } });
  expect(e.headers["x-openai-internal-codex-residency"]).toBe("us");
  expect(e.headers["x-preserve"]).toBe("yes");
  expect(h.hooks.map(hook => hook.name)).not.toContain("chat.headers");
  await h.unload();
});

for (const kind of ["primary", "title", "generate", "compaction"]) {
  test(`${kind}: native WS handshake and response.create, independent of ua_override`, async () => {
    const h = await host({ openai: { transport: "websocket", ws_transport: true, enforce_residency: "us" } }, { alias: "gpt-5.6-sol" });
    expect(h.hooks.some(hook => hook.name === "http.request")).toBe(false);
    const e = await h.run("experimental.ws.handshake", { ...event("openai", "alias", kind), url: "wss://chatgpt.com/backend-api/codex/responses", headers: { Authorization: "Bearer fixture", "X-Custom": "keep", "chatgpt-account-id": "fixture" } });
    expect(e.headers.authorization).toBe("Bearer fixture");
    expect(e.headers["x-custom"]).toBe("keep");
    expect(e.headers["chatgpt-account-id"]).toBe("fixture");
    expect(e.headers["x-openai-internal-codex-residency"]).toBe("us");
    expect(e.headers.originator).toBe("codex_cli_rs");
    expect(e.headers["openai-beta"]).toBe("responses_websockets=2026-02-06");
    const frame = await h.run("experimental.ws.send", { ...event("openai", "alias", kind), frame: JSON.stringify({ type: "response.create", model: "gpt-5.6-sol", input: [], reasoning: { summary: "auto" } }) });
    expect(JSON.parse(frame.frame)).toEqual({ type: "response.create", model: "gpt-5.6-sol", input: [], service_tier: "priority", reasoning: { effort: "medium", summary: "auto" } });
    const existing = JSON.stringify({ type: "response.create", model: "gpt-5.6-sol", service_tier: "flex", reasoning: { effort: "high" } });
    expect((await h.run("experimental.ws.send", { ...event("openai", "alias", kind), frame: existing })).frame).toBe(existing);
    const other = JSON.stringify({ type: "response.create", model: "gpt-other" });
    expect((await h.run("experimental.ws.send", { ...event("openai", "gpt-other", kind), frame: other })).frame).toBe(other);
    await h.unload();
  });
}

test("cleanup is idempotent, retained callbacks do nothing, re-setup has no stale state", async () => {
  const h = await host({ openai: { transport: "http", ua_override: true } });
  const callback = h.hooks.find(hook => hook.name === "http.request")!.run;
  await h.unload();
  await h.cleanup?.();
  const input = request("gpt-x");
  const e = { ...event(), request: input };
  await callback(e);
  expect(e.request).toBe(input);
  const next = await host({ openai: {} });
  expect(next.hooks.some(hook => hook.name === "http.request")).toBe(false);
  await next.unload();
});

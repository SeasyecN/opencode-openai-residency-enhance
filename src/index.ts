import { Plugin } from "@opencode/plugin";
import { readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Options = Record<string, unknown>;
const ID = "@seasyecn/opencode-openai-residency-enhance";
const originator = "codex_cli_rs";
const defaults = ["chatgpt.com/backend-api/codex", "api.openai.com"];
const object = (value: unknown): Options =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Options : {};

// Deliberately never log URLs, headers, bodies, file paths, or exception messages.
function debug(message: string) {
  if (!process.env.OPENCODE_RESIDENCY_DEBUG) return;
  const line = `opencode-openai-residency: ${message}\n`;
  if (process.env.OPENCODE_RESIDENCY_DEBUG_FILE) {
    try { appendFileSync(process.env.OPENCODE_RESIDENCY_DEBUG_FILE, line); } catch { /* optional diagnostics */ }
  } else process.stderr.write(line);
}

function localConfig(): Options {
  const path = process.env.OPENCODE_RESIDENCY_CONFIG_FILE ||
    join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode", "opencode-openai-residency-local.json");
  try { return object(JSON.parse(readFileSync(path, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") debug("local configuration unavailable");
    return {};
  }
}

function settings(provider: Options, local: Options) {
  // Preserve historical precedence: local scalar values win; boolean master
  // switches are ORed; target fragments are additive, never shared by providers.
  const merged = { ...provider };
  for (const key of ["ua_version", "ua_string", "claude_ua_string"])
    if (typeof local[key] === "string" && local[key]) merged[key] = local[key];
  if (typeof local.ua_gpt_models === "boolean") merged.ua_gpt_models = local.ua_gpt_models;
  const fragments = new Set(defaults);
  for (const source of [provider, local]) {
    const values = [source.baseURL, ...(Array.isArray(source.ua_target_fragments) ? source.ua_target_fragments : [])];
    for (const value of values) {
      if (typeof value !== "string" || !value) continue;
      const fragment = value.replace(/\/+$/, "");
      fragments.add(fragment);
      try { fragments.add(new URL(fragment).host); } catch { /* raw fragment supported */ }
    }
  }
  const strings = (value: unknown) => Array.isArray(value) && value.length > 0
    ? value.filter((item): item is string => typeof item === "string") : undefined;
  const wsModels = strings(local.ws_models) ?? strings(provider.ws_models) ?? ["gpt-5.6-sol"];
  const version = typeof merged.ua_version === "string" && merged.ua_version || "999.999.999";
  return {
    ua: provider.ua_override === true || local.ua_override === true,
    gpt: merged.ua_gpt_models === true,
    ws: provider.ws_transport === true || local.ws_transport === true,
    wsModels,
    residency: provider.enforce_residency,
    codexUA: typeof merged.ua_string === "string" && merged.ua_string ||
      `${originator}/${version} (Windows 10.0.26100; x86_64) WindowsTerminal (${originator}; ${version})`,
    claudeUA: typeof merged.claude_ua_string === "string" && merged.claude_ua_string || "claude-cli/2.1.220 (external, cli)",
    matches(url: string, model: string) {
      return [...fragments].some(fragment => fragment && url.includes(fragment)) ||
        (merged.ua_gpt_models === true && model.toLowerCase().startsWith("gpt"));
    },
  };
}
type Settings = ReturnType<typeof settings>;

function headers(input: Headers, config: Settings, model: string, applyUA: boolean, forceCodex = false) {
  if (config.residency) input.set("x-openai-internal-codex-residency", String(config.residency));
  if (!applyUA && !forceCodex) return;
  const claude = !forceCodex && model.toLowerCase().startsWith("claude-");
  input.set("user-agent", claude ? config.claudeUA : config.codexUA);
  input.delete("originator");
  if (!claude) input.set("originator", originator);
}

function replaceHeaders(target: Record<string, string>, source: Headers) {
  for (const key of Object.keys(target)) delete target[key];
  for (const [key, value] of source) target[key] = value;
}

function wsBody(body: Options) {
  if (!body.service_tier) body.service_tier = "priority";
  const reasoning = object(body.reasoning);
  if (!reasoning.effort) body.reasoning = { ...reasoning, effort: process.env.OPENCODE_CODEX_REASONING || "medium" };
}

export const OpenAIResidencyPlugin = Plugin.define({
  id: ID,
  async setup(ctx) {
    let disposed = false;
    const providers = await ctx.provider.list();
    // Registrations are host-owned. No timers, sockets, fetch wrappers, globals,
    // or subscriptions are installed; unload only invalidates in-flight reads.
    for (const provider of providers.data) {
      const providerID = provider.id;
      let httpHook: boolean | undefined;
      let websocket: boolean | undefined;
      let uaInitially: boolean | undefined;
      const read = async () => {
        const current = await ctx.provider.get({ providerID });
        if (disposed) return;
        const raw = object(current.data.settings);
        const config = settings(raw, localConfig());
        if (websocket !== undefined && websocket !== (raw.transport === "websocket"))
          throw new Error(`${ID}: reload the plugin after changing provider transport`);
        if (uaInitially === false && raw.transport !== "websocket" && config.ua)
          throw new Error(`${ID}: reload the plugin after enabling ua_override`);
        if (config.ws && raw.transport !== "websocket") {
          throw new Error(`${ID}: ws_transport requires provider settings.transport="websocket" in V2; selective HTTP-to-WS interception is no longer supported`);
        }
        return { config, raw };
      };
      const initial = await read();
      if (!initial) continue;
      uaInitially = initial.config.ua;
      const nativeDefault = ["openai", "azure", "xai"].includes(provider.canonical || providerID);
      websocket = initial.raw.transport === "websocket";
      httpHook = !websocket && (!nativeDefault || initial.raw.transport === "http") && initial.config.ua;
      const scope = { providerID };
      const resolveModel = async (id: string) => {
        const models = await ctx.model.list();
        return models.data.find(model => model.providerID === providerID && model.id === id)?.modelID ?? id;
      };
      const endpoint = (raw: Options) => typeof raw.baseURL === "string" ? raw.baseURL :
        providerID === "openai" ? "https://api.openai.com/v1" : "";

      await ctx.session.hook("model.request", async event => {
        const state = await read();
        if (!state) return;
        const modelID = await resolveModel(event.model.id);
        if (disposed) return;
        const output = new Headers(event.headers);
        headers(output, state.config, modelID, state.config.ua && state.config.matches(
          event.baseURL || endpoint(state.raw), modelID));
        replaceHeaders(event.headers, output);
      }, scope);

      // Native HTTP hooks opt a provider out of WebSocket in OpenCode 2.0.30.
      // Do not register one on explicitly native-WS providers (even if the
      // plugin's ws_transport flag is off). Never downgrade unrelated providers.
      if (httpHook) {
        await ctx.session.hook("http.request", async event => {
          const state = await read();
          if (!state) return;
          let body: Options = {};
          if (!event.request.headers.has("content-encoding")) {
            try { body = object(await event.request.clone().json()); } catch { /* non-JSON request */ }
          }
          if (disposed) return;
          const model = typeof body.model === "string" ? body.model : await resolveModel(event.model.id);
          if (disposed) return;
          const applyUA = state.config.ua && state.config.matches(event.request.url, model);
          const requestHeaders = new Headers(event.request.headers);
          headers(requestHeaders, state.config, model, applyUA);
          const url = new URL(event.request.url);
          if (applyUA && model.toLowerCase().startsWith("claude-")) url.searchParams.set("beta", "true");
          const next = new Request(url, event.request);
          for (const key of [...next.headers.keys()]) next.headers.delete(key);
          for (const [key, value] of requestHeaders) next.headers.set(key, value);
          event.request = next;
        }, scope);
      }

      await ctx.session.hook("experimental.ws.handshake", async event => {
        const state = await read();
        if (!state) return;
        const modelID = await resolveModel(event.model.id);
        if (disposed) return;
        const selected = state.config.ws && state.config.wsModels.includes(modelID) &&
          state.config.matches(event.url, modelID);
        const output = new Headers(event.headers);
        headers(output, state.config, modelID,
          state.config.ua && state.config.matches(event.url, modelID), selected);
        if (selected) output.set("openai-beta", "responses_websockets=2026-02-06");
        replaceHeaders(event.headers, output);
      }, scope);

      await ctx.session.hook("experimental.ws.send", async event => {
        const state = await read();
        if (!state || !state.config.ws) return;
        let body: Options;
        try { body = object(JSON.parse(event.frame)); } catch { return; }
        if (body.type !== "response.create" || typeof body.model !== "string" ||
          !state.config.wsModels.includes(body.model)) return;
        const modelID = await resolveModel(event.model.id);
        if (disposed || !state.config.matches(endpoint(state.raw), modelID)) return;
        wsBody(body);
        event.frame = JSON.stringify(body);
      }, scope);
    }
    return () => { disposed = true; };
  },
});

export default OpenAIResidencyPlugin;

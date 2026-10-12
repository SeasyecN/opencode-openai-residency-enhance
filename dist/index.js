import * as fs from "node:fs";

// ---------------------------------------------------------------------------
// opencode-openai-residency — residency header + Codex client unlock
// ---------------------------------------------------------------------------
// Three independent, opt-in features for the OpenAI Codex backend
// (https://chatgpt.com/backend-api/codex/responses):
//
//   1. enforce_residency  -> attaches x-openai-internal-codex-residency.
//   2. ua_override        -> forges User-Agent + originator on the HTTP path so
//                            gpt-5.5 / gpt-5.6-terra / gpt-5.6-luna pass the
//                            codex_cli_rs client gate.
//   3. ws_transport       -> plugin-owned WebSocket transport for WS-only models
//                            (gpt-5.6-sol), which OpenAI does NOT serve over
//                            plain HTTP. INDEPENDENT of ua_override.
//
// Why a globalThis.fetch monkey-patch (not chat.headers) for 2 & 3:
//   * opencode 1.14.x's Vercel AI SDK builds its own request and ignores hook
//     overrides for default headers like User-Agent, so the only effective place
//     to forge identity is the fetch layer.
//   * opencode reads OPENCODE_EXPERIMENTAL_WEBSOCKETS and constructs its built-in
//     Codex WS path BEFORE user plugins load, so a plugin cannot enable it. To
//     avoid forcing an env var, we perform the WS round-trip ourselves: intercept
//     the streaming POST, replay it over wss://, and translate the WebSocket
//     frames back into the SSE stream opencode's Responses parser expects.
//
// gpt-5.6-sol additionally requires `service_tier: "priority"` in the body (the
// only accepted tier) and a sufficiently recent codex_cli_rs version. The version
// gate is ">= minimum", so an absurdly high default never needs chasing.
// ---------------------------------------------------------------------------

const CODEX_ORIGINATOR = "codex_cli_rs";
const DEFAULT_UA_VERSION = "999.999.999"; // gate is ">= min"; high never expires
const DEFAULT_WS_MODELS = ["gpt-5.6-sol"];
const DEFAULT_LOCAL_CONFIG_BASENAME = "opencode-openai-residency-local.json";
const CODEX_TARGET_FRAGMENTS = [
    "chatgpt.com/backend-api/codex",
    "api.openai.com",
];
const codexTargetFragments = new Set(CODEX_TARGET_FRAGMENTS);
// Flags synced from opencode's parsed config in the chat.headers hook below,
// then read by the globalThis.fetch wrapper at request time. Defaults preserve
// opt-in semantics: every feature is OFF until config turns it on.
let uaOverrideEnabled = false;
let uaGptModelsEnabled = false;
let wsTransportEnabled = false;
let uaVersion = DEFAULT_UA_VERSION;
let uaStringOverride;
let claudeUAStringOverride;
let wsModels = new Set(DEFAULT_WS_MODELS);
const codexUA = () => uaStringOverride || `${CODEX_ORIGINATOR}/${uaVersion} (Windows 10.0.26100; x86_64) WindowsTerminal (${CODEX_ORIGINATOR}; ${uaVersion})`;
const claudeUA = () => claudeUAStringOverride || "claude-cli/2.1.220 (external, cli)";
const localConfigPath = () => {
    if (process.env.OPENCODE_RESIDENCY_CONFIG_FILE)
        return process.env.OPENCODE_RESIDENCY_CONFIG_FILE;
    const configHome = process.env.XDG_CONFIG_HOME || `${process.env.HOME}/.config`;
    return `${configHome}/opencode/${DEFAULT_LOCAL_CONFIG_BASENAME}`;
};
const loadLocalConfig = () => {
    try {
        return JSON.parse(fs.readFileSync(localConfigPath(), "utf8"));
    }
    catch (e) {
        if (e?.code !== "ENOENT")
            debugLog(`failed to read local config ${localConfigPath()}: ${e?.message ?? String(e)}`);
        return {};
    }
};
const addTargetFragment = (value) => {
    if (typeof value !== "string" || !value)
        return;
    const trimmed = value.replace(/\/+$/, "");
    codexTargetFragments.add(trimmed);
    try {
        const parsed = new URL(trimmed);
        codexTargetFragments.add(parsed.host);
    }
    catch {
        // Not a full URL; keep the raw fragment only.
    }
};
const targetMatches = (url) => {
    const normalized = url.replace(/\/+$/, "");
    for (const fragment of codexTargetFragments) {
        if (fragment && normalized.includes(fragment))
            return true;
    }
    return false;
};
const applyOptions = (opts) => {
    addTargetFragment(opts.baseURL);
    if (Array.isArray(opts.ua_target_fragments)) {
        for (const fragment of opts.ua_target_fragments)
            addTargetFragment(fragment);
    }
    if (typeof opts.ua_version === "string" && opts.ua_version) {
        uaVersion = opts.ua_version;
    }
    if (typeof opts.ua_string === "string" && opts.ua_string) {
        uaStringOverride = opts.ua_string;
    }
    if (typeof opts.claude_ua_string === "string" && opts.claude_ua_string) {
        claudeUAStringOverride = opts.claude_ua_string;
    }
    if (typeof opts.ua_gpt_models === "boolean") {
        uaGptModelsEnabled = opts.ua_gpt_models;
    }
    if (Array.isArray(opts.ws_models) && opts.ws_models.length > 0) {
        wsModels = new Set(opts.ws_models.filter((m) => typeof m === "string"));
    }
};
const readRequestBodyText = async (input, init) => {
    let raw = init?.body;
    if (raw == null && input instanceof Request) {
        try {
            raw = await input.clone().text();
        }
        catch {
            return undefined;
        }
    }
    if (typeof raw === "string")
        return raw;
    if (raw instanceof Uint8Array)
        return new TextDecoder().decode(raw);
    return undefined;
};
const getBodyModel = async (input, init) => {
    const raw = await readRequestBodyText(input, init);
    if (!raw)
        return undefined;
    try {
        const body = JSON.parse(raw);
        return typeof body?.model === "string" ? body.model : undefined;
    }
    catch {
        return undefined;
    }
};
const isGptModelRequest = async (input, init) => {
    if (!uaOverrideEnabled || !uaGptModelsEnabled)
        return false;
    const model = await getBodyModel(input, init);
    return typeof model === "string" && model.toLowerCase().startsWith("gpt");
};
function debugLog(line) {
    if (!process.env.OPENCODE_RESIDENCY_DEBUG)
        return;
    const target = process.env.OPENCODE_RESIDENCY_DEBUG_FILE;
    const stamp = new Date().toISOString();
    const msg = `[${stamp}] ${line}\n`;
    if (target) {
        try {
            fs.appendFileSync(target, msg);
        }
        catch {
            // ignore
        }
    }
    else {
        process.stderr.write(`opencode-openai-residency: ${msg}`);
    }
}
// Replay a Codex /responses POST over the WebSocket transport and translate the
// frames back into an SSE Response (one `data: <frame>` block per frame, ending
// with `data: [DONE]`), mirroring opencode's built-in ws.ts behaviour.
function wsToSse(wsUrl, headers, body, signal) {
    const WS = globalThis.WebSocket;
    const socket = new WS(wsUrl, { headers });
    const enc = new TextEncoder();
    const stream = new ReadableStream({
        start(controller) {
            let done = false;
            const finish = (emitDone) => {
                if (done)
                    return;
                done = true;
                try {
                    if (emitDone)
                        controller.enqueue(enc.encode("data: [DONE]\n\n"));
                }
                catch {
                    // stream already torn down
                }
                try {
                    controller.close();
                }
                catch {
                    // already closed
                }
                try {
                    socket.close();
                }
                catch {
                    // already closed
                }
            };
            const fail = (msg) => {
                if (done)
                    return;
                done = true;
                try {
                    controller.error(new Error(msg));
                }
                catch {
                    // already errored
                }
                try {
                    socket.close();
                }
                catch {
                    // already closed
                }
            };
            socket.addEventListener("open", () => {
                try {
                    socket.send(JSON.stringify({ ...body, type: "response.create" }));
                }
                catch (e) {
                    fail(`ws send failed: ${e?.message ?? String(e)}`);
                }
            });
            socket.addEventListener("message", (ev) => {
                // Codex WS frames are JSON text; ignore non-text frames defensively.
                const text = typeof ev.data === "string" ? ev.data : "";
                if (!text)
                    return;
                const eventText = text
                    .split(/\r?\n/)
                    .map((l) => `data: ${l}`)
                    .join("\n");
                controller.enqueue(enc.encode(`${eventText}\n\n`));
                let evt;
                try {
                    evt = JSON.parse(text);
                }
                catch {
                    return;
                }
                if (evt?.type === "response.completed" || evt?.type === "response.done") {
                    finish(true);
                }
                else if (evt?.type === "response.failed" ||
                    evt?.type === "response.incomplete" ||
                    evt?.type === "error") {
                    finish(true);
                }
            });
            socket.addEventListener("error", () => fail("websocket error"));
            socket.addEventListener("close", () => finish(false));
            if (signal)
                signal.addEventListener("abort", () => finish(false));
        },
    });
    return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
    });
}
function patchFetchForCodex() {
    const g = globalThis;
    if (g.__opencodeOpenAIResidencyFetchPatched)
        return;
    g.__opencodeOpenAIResidencyFetchPatched = true;
    debugLog("fetch patch installed");
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
        let url = "";
        try {
            url =
                typeof input === "string"
                    ? input
                    : input instanceof URL
                        ? input.href
                        : input?.url ?? "";
        }
        catch {
            return origFetch(input, init);
        }
        if (!targetMatches(url) && !(await isGptModelRequest(input, init))) {
            return origFetch(input, init);
        }
        // --- WS transport for WS-only models (gpt-5.6-sol). Independent of ua_override. ---
        if (wsTransportEnabled) {
            const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
            if (method === "POST" && url.includes("/responses")) {
                let raw = init?.body;
                if (raw == null && input instanceof Request) {
                    try {
                        raw = await input.clone().text();
                    }
                    catch {
                        // unreadable body: fall through to HTTP path
                    }
                }
                if (typeof raw === "string") {
                    let body;
                    try {
                        body = JSON.parse(raw);
                    }
                    catch {
                        // not JSON: fall through to HTTP path
                    }
                    if (body &&
                        typeof body.model === "string" &&
                        wsModels.has(body.model) &&
                        body.stream) {
                        if (!body.service_tier)
                            body.service_tier = "priority";
                        const reasoning = body.reasoning;
                        if (!reasoning?.effort) {
                            body.reasoning = {
                                effort: process.env.OPENCODE_CODEX_REASONING || "medium",
                            };
                        }
                        const reqHeaders = new Headers(init?.headers ??
                            (input instanceof Request ? input.headers : undefined));
                        const wsHeaders = {
                            authorization: reqHeaders.get("authorization") ?? "",
                            "openai-beta": "responses_websockets=2026-02-06",
                            originator: CODEX_ORIGINATOR,
                            "user-agent": codexUA(),
                        };
                        const acc = reqHeaders.get("chatgpt-account-id");
                        if (acc)
                            wsHeaders["chatgpt-account-id"] = acc;
                        const res = reqHeaders.get("x-openai-internal-codex-residency");
                        if (res)
                            wsHeaders["x-openai-internal-codex-residency"] = res;
                        debugLog(`WS transport for ${body.model}`);
                        try {
                            return wsToSse(url.replace(/^http/, "ws"), wsHeaders, body, init?.signal);
                        }
                        catch (e) {
                            debugLog("WS setup failed, falling back to HTTP: " +
                                (e?.message ?? String(e)));
                        }
                    }
                }
            }
        }
        // --- HTTP path: forge UA + originator (gpt-5.5 / terra / luna). ---
        if (!uaOverrideEnabled) {
            return origFetch(input, init);
        }
        const effectiveRequest = input instanceof Request
            ? new Request(input, init)
            : undefined;
        const baseHeaders = effectiveRequest?.headers ?? init?.headers;
        const h = new Headers(baseHeaders ?? {});
        const beforeUA = h.get("User-Agent") ?? "(unset)";
        const beforeOrig = h.get("originator") ?? "(unset)";
        const requestModel = effectiveRequest
            ? await getBodyModel(effectiveRequest)
            : await getBodyModel(input, init);
        const isClaudeRequest = typeof requestModel === "string" && requestModel.toLowerCase().startsWith("claude-");
        for (const k of ["User-Agent", "user-agent", "USER-AGENT"])
            h.delete(k);
        for (const k of ["originator", "Originator", "ORIGINATOR"])
            h.delete(k);
        const ua = isClaudeRequest ? claudeUA() : codexUA();
        h.set("User-Agent", ua);
        if (!isClaudeRequest)
            h.set("originator", CODEX_ORIGINATOR);
        debugLog(`intercepted ${url} | model ${requestModel ?? "(unknown)"} | UA ${beforeUA} -> ${ua} | originator ${beforeOrig} -> ${isClaudeRequest ? "(removed)" : CODEX_ORIGINATOR}`);
        if (effectiveRequest) {
            const requestURL = new URL(effectiveRequest.url);
            if (isClaudeRequest)
                requestURL.searchParams.set("beta", "true");
            const rewrittenRequest = new Request(requestURL, effectiveRequest);
            for (const key of [...rewrittenRequest.headers.keys()])
                rewrittenRequest.headers.delete(key);
            for (const [key, value] of h)
                rewrittenRequest.headers.set(key, value);
            return origFetch(rewrittenRequest);
        }
        let target = input;
        if (isClaudeRequest) {
            const requestURL = new URL(String(input));
            requestURL.searchParams.set("beta", "true");
            target = requestURL;
        }
        return origFetch(target, { ...(init ?? {}), headers: h });
    });
}
// Module-scope side effect: install the fetch wrapper unconditionally before any
// AI SDK fetch fires. While all feature flags are false (the default) the wrapper
// short-circuits to origFetch on every call — near-zero overhead. The chat.headers
// hook flips the flags once it sees opencode's parsed config.
patchFetchForCodex();
export const OpenAIResidencyPlugin = async () => ({
    "chat.headers": async (input, output) => {
        // Sync flags from opencode-provided, jsonc-parsed, path-resolved config so we
        // never read the config file ourselves (which broke on project-local configs,
        // Windows %APPDATA%, XDG overrides, and jsonc comments in earlier versions).
        const opts = input.provider?.options ?? {};
        const localOpts = loadLocalConfig();
        if (input.model.providerID !== "openai" &&
            opts.ua_override !== true &&
            localOpts.ua_override !== true &&
            opts.ws_transport !== true &&
            localOpts.ws_transport !== true &&
            localOpts.ua_gpt_models !== true &&
            !opts.enforce_residency) {
            return;
        }
        uaOverrideEnabled = opts.ua_override === true || localOpts.ua_override === true;
        wsTransportEnabled = opts.ws_transport === true || localOpts.ws_transport === true;
        applyOptions(opts);
        applyOptions(localOpts);
        const residency = opts.enforce_residency;
        if (residency) {
            output.headers["x-openai-internal-codex-residency"] = String(residency);
        }
    },
});
export default OpenAIResidencyPlugin;
//# sourceMappingURL=index.js.map

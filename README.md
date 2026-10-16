# @seasyecn/opencode-openai-residency-enhance

V2 plugin for OpenAI Codex residency headers, client User-Agent/originator overrides,
gateway targeting, and experimental native WebSocket request customization.

## Compatibility and release status

Version **2.0.0** targets **OpenCode 2.0.30** and depends on exactly
`@opencode/plugin@2.0.30`. It does not implement V1's `server()` or `chat.headers`.
Use the previous package version for V1. Importing this package does not patch
`fetch`, `WebSocket`, environment variables, or any other plugin.

**Migration limitation / release gate:** V1's plugin-owned, per-model HTTP-to-WS
bridge is removed. V2 selects native WebSocket transport at the **provider** level;
there is no public request hook to select it by `ws_models`. This version refuses
`ws_transport: true` unless the provider explicitly sets
`settings.transport: "websocket"`. It never enables provider-wide WS on your behalf.
`ws_models` now selects handshake/payload tweaks, **not transport routing**. If
selective WS-only routing is essential, do not upgrade until that migration decision
has been resolved. This behavior difference requires release approval; passing the
local fixtures does not resolve it.

## Installation after publication

The working tree is a release candidate; these instructions do not assert that
2.0.0 has been published.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@seasyecn/opencode-openai-residency-enhance@2.0.0"]
}
```

For development, put the package directory path in `plugins` after building it.
Do not copy compiled files into OpenCode's package cache. V1's singular `plugin`
configuration should be migrated to V2's `plugins`; merely wrapping V1 hooks in
an empty `setup` does not migrate the implementation.

## Configuration

V2 uses `providers.<id>.settings` (V1 used `provider.<id>.options`). The plugin reads
the active provider through the public V2 context; it does not parse opencode.json
itself, change its base URL, select models, or replace credentials.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@seasyecn/opencode-openai-residency-enhance@2.0.0"],
  "providers": {
    "openai": {
      "settings": {
        "enforce_residency": "us",
        "ua_override": true,
        "ua_version": "999.999.999"
      }
    }
  }
}
```

`enforce_residency` is **provider-only**, never loaded from the fallback JSON file.
It adds `x-openai-internal-codex-residency` to the selected provider's requests,
including native WebSocket handshakes. Setting a header does not itself guarantee
regional processing: the upstream account and service must support it.

### Historical local fallback

The filename remains `opencode-openai-residency-local.json` under
`$XDG_CONFIG_HOME/opencode/` or `~/.config/opencode/`. Override the path with
`OPENCODE_RESIDENCY_CONFIG_FILE`. No private configuration is distributed.

```json
{
  "ua_override": true,
  "ua_gpt_models": true,
  "ua_string": "Codex Desktop/0.142.5 (Ubuntu 22.4.0; x86_64) xterm-256color (Codex Desktop; 26.623.101652)",
  "claude_ua_string": "claude-cli/2.1.220 (external, sdk-cli)",
  "ua_target_fragments": ["https://gateway.example.com/v1"]
}
```

Provider and local `ua_override` / `ws_transport` switches are ORed: local `false`
does not disable provider `true`. Nonempty local UA strings/version and nonempty
`ws_models` override provider values; a local boolean `ua_gpt_models` overrides
the provider value. URL fragments and `baseURL` targets are additive. Local
`baseURL` is **only a match target**, never an endpoint override.

Settings are read on each request; changes to existing header values are picked
up without a timer. Reload the plugin after enabling `ua_override` from off,
adding providers, or changing transport, because hook registration affects native
transport selection. Hook/transform registrations belong to the host; cleanup
invalidates callbacks still in flight. There are no plugin-owned timers or sockets.

### Options

| Option | Source | Default | Behavior |
| --- | --- | --- | --- |
| `enforce_residency` | Provider only | unset | Residency header; independent of UA override. |
| `ua_override` | Both | `false` | Enables UA/originator rewriting on matching requests. |
| `ua_gpt_models` | Both | `false` | Also matches upstream model names starting with `gpt` (case-insensitive). Native HTTP inspects the JSON body; semantic/WS hooks resolve the model's upstream `modelID`. |
| `ua_version` | Both | `999.999.999` | Version in the generated Codex UA. |
| `ua_string` | Both | unset | Full Codex UA override. |
| `claude_ua_string` | Both | `claude-cli/2.1.220 (external, cli)` | UA for matching `claude-` models; removes `originator`. |
| `ua_target_fragments` | Both | `[]` | Additional URL substrings; URL values also contribute their host. |
| `baseURL` | Both | unset | Additional match target; provider baseURL still belongs to OpenCode. |
| `ws_transport` | Both | `false` | Enables selected native-WS handshake/frame tweaks; requires explicit native transport. **No V1 HTTP-to-WS bridge.** |
| `ws_models` | Both | `["gpt-5.6-sol"]` | Exact upstream model IDs receiving WS tweaks. Does not select the route. |

Built-in target substrings are `chatgpt.com/backend-api/codex` and `api.openai.com`.
Configured target matches intentionally retain the historical substring/host
semantics; use trusted, specific fragments. A global local file is an explicit
cross-provider opt-in, but provider-specific options and accumulated targets never
leak from one provider to another. No opt-in means no identity overrides.

Default Codex UA:

```text
codex_cli_rs/<version> (Windows 10.0.26100; x86_64) WindowsTerminal (codex_cli_rs; <version>)
```

Matching Codex requests use `originator: codex_cli_rs`. Matching Claude HTTP
requests instead remove that header and set `beta=true`, preserving other query
parameters. All other headers, authentication, method, body, model, and endpoint
are retained.

## HTTP and native WebSocket behavior

`model.request` applies headers for all request kinds: primary, title, generate,
and compaction. Provider-scoped `http.request` handles final headers, body-model
matching, and Claude's beta query on HTTP-only providers with UA override enabled.
No unscoped HTTP hook or global fetch wrapper is installed.

OpenCode forces providers with HTTP hooks onto HTTP. To avoid disabling native
WS, this plugin does **not** register HTTP hooks for explicitly WS providers, or
for built-in OpenAI/Azure/xAI defaults unless `transport: "http"` is explicit.
Those routes use semantic headers plus `experimental.ws.handshake`. Consequently,
Claude beta-query rewriting and native-body inspection require an HTTP provider;
they cannot operate on a native-WS provider's HTTP fallback. Model aliases are
resolved to upstream IDs. Compressed HTTP bodies are not decoded or modified;
the resolved upstream model ID is used instead of inspecting their raw body.

Example of the explicit, provider-wide transport decision:

```jsonc
{
  "providers": {
    "openai": {
      "settings": {
        "transport": "websocket",
        "ws_transport": true,
        "ws_models": ["gpt-5.6-sol"]
      }
    }
  }
}
```

For selected matching models, the handshake adds the Codex UA/originator and
`openai-beta: responses_websockets=2026-02-06`, independent of `ua_override`.
Other original handshake headers are retained. Outgoing `response.create` frames
get `service_tier: "priority"` if absent and reasoning effort from
`OPENCODE_CODEX_REASONING` (default `medium`) if absent. Existing tier, reasoning
effort and unrelated fields are preserved. Other frames/models are not rewritten.
Connection pooling, framing, incoming events, cancellation, reconnection and
HTTP fallback are owned by OpenCode, not by this plugin. Routes without native WS
support may fall back to HTTP; this plugin does not make a WS-only model work on
an unsupported gateway.

## Verification and diagnostics

```sh
bun install
bun run typecheck
bun test
bun run build
bun pm pack
```

Fixtures invoke actual `setup`, capture and execute real registered callbacks,
and cover scopes, header preservation, aliases, HTTP/WS request kinds, config
changes and cleanup. They do not call any upstream model or gateway. No live
network compatibility, regional routing, client gate acceptance, or full OpenCode
service integration is claimed. Independent QA and an installed-package check
remain required before release.

`OPENCODE_RESIDENCY_DEBUG=1` enables generic diagnostic messages; optionally direct
them to `OPENCODE_RESIDENCY_DEBUG_FILE`. Diagnostics never include URLs, headers,
credentials, prompts, bodies, local paths, or raw exception messages.

## Provenance and license

Derived from [DusKing1/opencode-openai-residency](https://github.com/DusKing1/opencode-openai-residency),
by Hugo Chiang ([@DusKing1](https://github.com/DusKing1)), MIT licensed.
Enhanced fork: [SeasyecN/opencode-openai-residency-enhance](https://github.com/SeasyecN/opencode-openai-residency-enhance).
The fork adds local fallback configuration, custom UA strings, gateway targets,
body-model matching, and Claude request handling. V2 replaces the historical
global fetch patch with scoped hooks.

MIT; see [LICENSE](./LICENSE). Copyright © 2026 Hugo Chiang and SeasyecN.

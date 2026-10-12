# @seasyecn/opencode-openai-residency-enhance

OpenCode plugin for OpenAI Codex API compatibility tweaks:

1. **Data Residency** — Attaches `x-openai-internal-codex-residency` for OpenAI Enterprise workspaces with regional data restrictions.
2. **User-Agent / Client Gate Override** — Overrides `User-Agent` and `originator` headers on outgoing requests to satisfy backend client gates (e.g. `codex_cli_rs` client gate for models such as GPT-5.5 / GPT-5.6).
3. **WebSocket Transport for WS-Only Models (Experimental)** — Opt-in transport for WebSocket-only Codex models (such as `gpt-5.6-sol`) over Codex WebSocket transport (`wss://`), injecting the required service tier and translating frames to SSE streams.
4. **Enhanced Configuration & Gateway Support** — Supports external configuration via `opencode-openai-residency-local.json` or environment variable, custom User-Agent strings, custom target URL fragments (for proxies/gateways), and selective request-body model matching.

---

## Provenance & Attribution

This package is derived from the upstream project:
- **Upstream Package**: [`opencode-openai-residency`](https://github.com/DusKing1/opencode-openai-residency)
- **Original Author**: Hugo Chiang ([@DusKing1](https://github.com/DusKing1))
- **Original License**: MIT License (Copyright © 2026 Hugo Chiang)
- **Enhanced Fork Repository**: [SeasyecN/opencode-openai-residency-enhance](https://github.com/SeasyecN/opencode-openai-residency-enhance)

### Enhancements in `@seasyecn/opencode-openai-residency-enhance`:
- **Local Config Fallback**: Reads `opencode-openai-residency-local.json` (from `~/.config/opencode/` or `$OPENCODE_RESIDENCY_CONFIG_FILE`), allowing client header and gateway settings when provider options cannot be modified directly.
- **Custom User-Agent Strings**: Configurable `ua_string` and `claude_ua_string` overrides.
- **Gateway & Proxy Support**: Configurable `ua_target_fragments` and `baseURL` targets for non-standard endpoints.
- **Body Model Inspection**: `ua_gpt_models` option to inspect request body models and intercept GPT requests across custom providers (e.g. proxy gateways).
- **Claude Request Rewriting**: Custom handling for Claude model requests with `claude_ua_string` and `beta=true` parameter.

---

## Installation

> **Note**: Public release to npm (`@seasyecn/opencode-openai-residency-enhance`) is pending. Until published, install from local repository or git URL.

Add to your `opencode.json`:

```jsonc
{
  // Once published to npm:
  "plugin": ["@seasyecn/opencode-openai-residency-enhance"]
}
```

Or for local development:

```jsonc
{
  "plugin": ["file:/path/to/@seasyecn/opencode-openai-residency-enhance"]
}
```

---

## Configuration

Configuration settings come from two sources with distinct scopes:

### 1. Provider Options (`opencode.json`)

Specified under `provider.<name>.options`:

```jsonc
{
  "provider": {
    "openai": {
      "options": {
        "enforce_residency": "us",          // Read ONLY from provider options
        "ua_override": true,
        "ws_transport": true,
        "ua_version": "999.999.999",
        "ws_models": ["gpt-5.6-sol"]
      }
    }
  }
}
```

> **IMPORTANT (`enforce_residency` scope)**: `enforce_residency` is read **ONLY** from the active provider options in `opencode.json`. It is **NOT** read from the local JSON config file. If you require regional data residency headers, configure `enforce_residency` under the provider's `options` block.

### 2. Local Configuration File (`opencode-openai-residency-local.json`)

> **Runtime Compatibility Note**: To preserve complete backward compatibility with existing environments and active installations, the configuration file retains its historical filename `opencode-openai-residency-local.json`. Existing configuration files and active plugin paths remain fully compatible without renaming.

For environments where provider options in `opencode.json` cannot be edited, client headers, gateways, and WebSocket options can be supplied via a local configuration file located at `~/.config/opencode/opencode-openai-residency-local.json` (or pointed to by `OPENCODE_RESIDENCY_CONFIG_FILE`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "ua_override": true,
  "ua_gpt_models": true,
  "ua_version": "999.999.999",
  "ua_string": "Codex Desktop/0.142.5 (Ubuntu 22.4.0; x86_64) xterm-256color (Codex Desktop; 26.623.101652)",
  "claude_ua_string": "claude-cli/2.1.220 (external, sdk-cli)",
  "ua_target_fragments": [
    "https://gateway.example.com/v1"
  ]
}
```

> **Supported Local Config Keys**: The local config file supports **ONLY** the implemented User-Agent, gateway, and WebSocket transport settings (`ua_override`, `ua_gpt_models`, `ua_version`, `ua_string`, `claude_ua_string`, `ua_target_fragments`, `baseURL`, `ws_transport`, `ws_models`). Setting `enforce_residency` in this file has no effect.

---

## Options Reference

| Option | Supported In | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `enforce_residency` | Provider options only | `string` | `undefined` | Region code (e.g. `"us"`) attached to `x-openai-internal-codex-residency`. |
| `ua_override` | Both | `boolean` | `false` | Master switch for User-Agent and originator header override. |
| `ua_gpt_models` | Both | `boolean` | `false` | When true, inspects request body and applies UA override to requests targeting models starting with `gpt`. |
| `ua_version` | Both | `string` | `"999.999.999"` | Client version sent in `codex_cli_rs/<version>`. |
| `ua_string` | Both | `string` | `undefined` | Full custom User-Agent string for Codex requests. |
| `claude_ua_string` | Both | `string` | `undefined` | Full custom User-Agent string for Claude requests. |
| `ua_target_fragments` | Both | `string[]` | `[]` | Additional URL substrings/hostnames to match for request interception. |
| `baseURL` | Both | `string` | `undefined` | Base URL added to target fragments for interception. |
| `ws_transport` | Both | `boolean` | `false` | Master switch for WebSocket transport (experimental). |
| `ws_models` | Both | `string[]` | `["gpt-5.6-sol"]` | List of model names to route over WebSocket. |

---

## WebSocket Transport Caveats (Experimental)

The `ws_transport` feature is an **experimental fallback transport**:
- **Test Scope**: Verified under mocked smoke checks with mocked WebSocket servers for frame-to-SSE parsing and payload structuring (`response.create`).
- **No Live Compatibility Guarantees**: Upstream OpenAI WebSocket protocol details and gateway handshake behaviors may change without notice. Real-world upstream endpoint behavior has not been independently verified.
- **No Reconnection or Session Recovery**: The transport establishes a single connection per request. There is no automatic retry, exponential backoff, connection pooling, or session resumption. If the socket closes or encounters a network error, the stream terminates immediately.
- **Cancellation**: Relies on standard `AbortSignal` listeners to close the active socket on client abort.

Use this feature with awareness of these architectural constraints.

---

## Debugging

Set environment variables to log intercepted requests:

- `OPENCODE_RESIDENCY_DEBUG=1`: Enables stderr debug logging.
- `OPENCODE_RESIDENCY_DEBUG_FILE=/path/to/log.txt`: Redirects debug logging to a specified file.

---

## License

MIT License. See [LICENSE](./LICENSE) for details.
Copyright (c) 2026 Hugo Chiang.
Copyright (c) 2026 SeasyecN.

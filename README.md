# KAI Tools

Manage and run Model Context Protocol tools from **KAI Core 0.2.0 or later**. This is an installable first-party KAI plugin, not a browser extension or a ChatGPT plugin.

## What works

- Reuse existing saved MCP server records without auto-starting them.
- Add Streamable HTTP endpoints or local stdio executables and JSON argument arrays.
- Start from KAI's bundled, version-pinned npm templates, including filesystem access with an explicitly entered folder path.
- Check system Node or explicitly install the hash-pinned KAI runtime into the existing runtime directory.
- Review every server launch natively, discover tool descriptions and schemas, then review each invocation and its exact arguments.
- Stop a server, remove its saved record, and inspect textual tool results.

## Install

Download the signed `kai.tools-0.1.0.kaiplugin` release asset, then select **Plugins → Install package** in KAI Core. Review the publisher and the three Tools permissions. Core pins the first-party publisher; an unsigned checkout is not an installable release.

Choose **Add a server**, save its connection details, and use **Review and connect**. Saving and opening this plugin never start servers automatically. Use **Run a tool** to inspect its schema and enter a JSON object of arguments.

## Process and data boundaries

**A local MCP server is an OS program running as your user. It is not sandboxed.** It may access files and the network. Only start programs you trust. A filesystem template's folder list is enforced by that external server, not by the plugin sandbox. Core shows the executable and argument array before launch; it launches directly without an implicit command shell and strips inherited credential and runtime-injection environment variables.

Core owns at most four active server process groups/trees for this plugin. Closing Tools or Core stops them; Stop server also interrupts pending requests. A deliberately hostile local program can escape normal process ownership, so this is lifecycle management, not a security sandbox.

HTTP requests use the reviewed endpoint, reject redirects and URL passwords, and keep session headers inside Core. Local-Only blocks HTTP servers and local programs unless you explicitly mark a trusted program as offline-safe. That checkbox is your assertion about the program; it cannot prevent a local program from accessing the network. Query credentials and command arguments are not returned in server metadata. Do not put secrets in command arguments or URLs; this release has no secret configuration editor for MCP servers.

Existing settings remain in place. Corrupt records, symlinked files, and external settings changes are rejected without replacement. Tool results belong to the selected server; the plugin has no Core API for Brain, wallet keys, or other plugins' account credentials.

## Limits and development

This release supports `initialize`, `tools/list`, and `tools/call` over newline-delimited stdio or Streamable HTTP. It does not implement server prompts/resources, server-initiated sampling, OAuth for arbitrary MCP endpoints, or automatic agent/workflow integration. Discovery is limited to 256 tools and bounded schema data; responses are bounded, and interactive calls time out. Windows `.cmd` shell fallbacks are rejected; npm templates require a directly resolvable Node/npm installation.

The `plugin/` frontend is dependency-free and uses only `window.kai.call`. Its reviewed native broker ships in Core. Permissions are `tools.read`, `tools.manage`, and `tools.execute`.

Run `npm test` using Node 20 or later. Standalone tests cover non-mutating startup, JSON argument boundaries, dispatch, and escaping. Core additionally launches a synthetic local MCP server to test real discovery, invocation, environment filtering, shutdown, privacy checks, and data preservation. Live third-party servers and Windows process-tree cleanup require platform validation.

Keep signing keys outside this repository. Core's release pipeline builds and signs the distributable.

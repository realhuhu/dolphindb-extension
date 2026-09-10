# Changelog

## 0.1.0a3 - 2026-09-11

- Keep Notebook metadata and cell execution on the same kernel shell, excluding queued cell runtime from metadata timeouts; cancel pending requests on restart/disconnect and refresh workspace panels after reconnect.
- Follow JupySQL's IPython magic/argument handling: remove frontend source detection and custom execution-error dialogs; preserve native cell execution when DDB is unconfigured or unavailable.
- Sort table previews using original SDK/pandas values before display formatting, preserving negative, decimal and large-integer order; keep active variable filters visible when the variable count shrinks.
- Remove nested scrollbars from table preview dialogs by letting the native dialog body own scrolling.
- Keep the current reading position when execution results are folded or expanded; resume automatic scrolling on new output or document reveal.
- Replace document toolbars and connection selectors with ReactiveToolbar, ToolbarButton and HTMLSelect; use native InputDialog pickers for symbols and batch execution.
- Use Jupyter TreeView/TreeItem for databases and variables, native sidebar/form/search controls for connection management, and OutputArea/rendermime with a sortable Table renderer for DOS results and previews.
- Preserve incremental print output, escaped cell text, independent sessions and debounced insertions; keep expanded workspace sections visible after both sections were collapsed.
- Scroll DOS execution results to the bottom as print messages, results and errors arrive.
- Reuse Jupyter Debugger's native resizable accordion for databases and variables, with immediate folding and independent scrolling; debounce variable insertion and table previews, scoped to the original document and cursor.
- Share DOS/Notebook connection and shutdown controls; show the active document's database and DDB session variables in one workspace panel.
- Compact hover, completion documentation and signature popups; remove inherited Markdown whitespace and keep long documentation scrollable.
- Prevent member completion such as `prices.` from falling back to all builtin functions when a file has not run; keep live table columns and SQL context candidates free of unrelated globals.
- Reuse upstream language-service algorithms for DOS, cell magics, and inline `%ddb`, with reproducible source hashes and CI verification.
- Add scoped symbols, snippets, module imports and definitions, SQL/catalog/schema/field completion, and missing-module diagnostics.
- Render full Chinese/English function documentation and active-parameter signature help in Jupyter's CodeMirror editors.
- Add module directory, documentation language and automatic completion settings.
- Read completion metadata from each DOS session or Python kernel session; keep pre-execution previews switchable and release them when the last page closes.
- Test module Contents reads, quoted completion prefixes, cross-document isolation, and kernel metadata message ordering.
- Add `%ddb` and `%%ddb` IPython magics, native `Session.run` return values, and `%%ddb -o` result capture.
- Add Notebook connection selection, DDB cell insertion/highlighting, and one reusable DDB session per Python kernel.
- Transfer selected connection credentials through authenticated API/comm messages without saving them in notebooks or history.
- Add the `notebook` Python extra and regression tests for result types, session lifecycle, kernel restart, and connection races.
- Wait for DDB readiness through Jupyter's cell executor so restart-and-run-all preserves mixed Python/DDB cell order.
- Forward SDK print messages to the current IPython cell, including on Windows.
- Resolve batch connection labels from retained sessions without opening inactive documents.
- Release unfinished database previews on editor close and restore previews when files are reopened.
- Keep closed files from opening preview sockets on connection/settings changes; cover DOS lifecycle races in frontend tests.
- Add DOS file creation, syntax highlighting, SDK-backed completions and function documentation.
- Reuse upstream execution code and database helpers for file, selection/line, and sequential batch execution.
- Bind each DOS file to its own connection snapshot and session after its first execution.
- Retain server-side sessions and output across editor close/browser reload; keep sessions when files are renamed.
- Add per-document database/variable panels, table results, print/error output, and interrupt controls.
- Register DOS sessions in Jupyter's Running panel for reopening and shutdown.
- Test session ownership, isolation, reconnect, in-flight requests, profile snapshots and lifecycle endpoints.

- Add grouped DolphinDB preferences to the Jupyter Settings Editor, with a sidebar shortcut.
- Apply new-connection defaults and sidebar display options through a shared, typed settings service.
- Migrate default connection profiles to the Jupyter config directory while retaining the original file and keyring identity.
- Support `DolphinDBExtensionApp.connections_dir` and preserve the legacy `data_dir` override.
- Namespace authorization resources as `dolphindb-extension:connections`.
- Test settings changes, migration, credential preservation, and authorization; package the settings schema.

## 0.1.0a2 - 2026-09-10

- Add a theme-aware connection sidebar for JupyterLab 4 and Notebook 7.
- Support creating, editing, deleting, testing, selecting, and disconnecting DolphinDB connections.
- Persist connection profiles and the last selection; store passwords in memory or the OS keyring.
- Reuse nine connection methods and shared types from a pinned DolphinDB VS Code submodule.
- Use the same DolphinDB JavaScript SDK through an authenticated Jupyter WebSocket relay.
- Add API authentication, relay, persistence, and credential handling tests.

DolphinDB script execution and Notebook code cells are not implemented in this release.

## 0.1.0a1 - 2026-09-10

- Initialize the `dolphindb-extension` Python package with uv and Hatchling.
- Add package metadata, a source layout, and reproducible environment setup.
- Document the planned DolphinDB VS Code to Jupyter migration.
- Add distribution build, metadata, and installation checks in GitHub Actions.

This initial scaffold does not yet implement any Jupyter extension features.

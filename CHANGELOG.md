# Changelog

## Unreleased

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

# Changelog

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

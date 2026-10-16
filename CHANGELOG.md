# Changelog

## [Unreleased]

### Added
- Code completion (inline ghost text) with a local code model through offgrid-server's `/infill`
- Local chat model in VS Code's Chat view (model picker, Ask and Agent modes)
- Model setup: downloads Qwen2.5-Coder 1.5B and Qwen3 4B Instruct (verified by SHA-256), or uses your own GGUF files
- One server shared by all VS Code windows
- Status bar item with the server state and completion timing
- **offgrid: Reset**: back to a fresh install (settings, remembered state, optionally the downloaded models)
- Qwen3-Coder 30B-A3B as an optional large chat model for 16 GB GPUs, with its expert weights partly on the CPU

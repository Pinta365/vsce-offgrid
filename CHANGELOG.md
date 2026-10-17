# Changelog

## [Unreleased]

### Added
- Tiny setup (Qwen3 0.6B chat, Qwen2.5-Coder 0.5B code completion, ~1.1 GB) for machines without a
  dedicated GPU or with less than 6 GB; recommended there instead of Small

### Changed
- Set Up Models offers either a setup (chat + code model together) or *Choose models one by one*, where chat
  models can be downloaded on their own too, with the same fit check

## [0.0.4] - 2026-10-17

### Added
- The offgrid log shows each chat request: its size, whether it was answered, thinking, timing, and
  cancellation

### Documentation
- Use Local chat sessions: Copilot CLI sessions need more context than local models have

## [0.0.3] - 2026-10-17

### Added
- Setups: Small (Qwen3 1.7B, for 6 GB GPUs and CPU-only machines), Standard (Qwen3 4B) and Large
  (Qwen3-Coder 30B), with a fit check against this machine's GPU and RAM and a recommendation.
  The GPU is read from offgrid-server's device list on first setup.
- Hybrid thinking models (Qwen3 1.7B) run with thinking off, as the chat view doesn't show it

### Fixed
- When Windows blocks the (unsigned) server, say so instead of "spawn UNKNOWN"
- A reply without text or tool calls (e.g. a thinking model that only thought) is explained instead of
  VS Code's "No response was returned"

## [0.0.2] - 2026-10-16

### Added
- Extension icon

## [0.0.1] - 2026-10-16

### Added
- Code completion (inline ghost text) with a local code model through offgrid-server's `/infill`
- Local chat model in VS Code's Chat view (model picker, Ask and Agent modes)
- Model setup: downloads Qwen2.5-Coder 1.5B and Qwen3 4B Instruct (verified by SHA-256), or uses your own GGUF files
- One server shared by all VS Code windows
- Status bar item with the server state and completion timing
- **offgrid: Reset**: back to a fresh install (settings, remembered state, optionally the downloaded models)
- Qwen3-Coder 30B-A3B as an optional large chat model for 16 GB GPUs, with its expert weights partly on the CPU

# offgrid: local AI

Code completion and chat in VS Code with models that run on your own machine. No account, no
API key and no cloud: after a one-time model download, nothing leaves your computer.

It is built on [offgrid](https://github.com/Pinta365/offgrid), which runs GGUF models through
llama.cpp on any GPU (Vulkan: AMD, NVIDIA, Intel) and falls back to the CPU.

## Features

- **Code completion**: suggestions as you type (ghost text; Tab accepts) from a code model with
  fill-in-the-middle, using the code before and after the cursor and code from files you recently
  visited.
- **Chat**: a local model in VS Code's Chat view. Pick **offgrid: Qwen3 4B** in the model picker;
  it works in Ask and Agent modes, with tool calling.
- **Bundled server**: the extension ships offgrid-server for your platform and starts it
  when needed. All VS Code windows share one server, so the models load once.

## Getting started

1. Install the extension. On first start it offers to download the models:
   - Qwen2.5-Coder 1.5B (1.5 GB) for code completion
   - Qwen3 4B Instruct (2.3 GB) for chat
2. Start typing. The status bar shows **offgrid** with the time of the last completion; click it
   for options.

Downloads are checked against their SHA-256 and kept in VS Code's storage for the extension. To
use models you already have, run **offgrid: Set Up Models** and pick your GGUF files.

## Settings

| Setting | Default | |
|---|---|---|
| `offgrid.completion.enabled` | `true` | Suggest code as you type |
| `offgrid.completion.model` | | A code model (GGUF with FIM tokens); empty: Qwen2.5-Coder 1.5B |
| `offgrid.chat.enabled` | `true` | Load the chat model (about 3 GB more memory) |
| `offgrid.chat.model` | | A chat model (GGUF); empty: Qwen3 4B Instruct |
| `offgrid.chat.contextSize` | `32768` | Chat context in tokens; Agent mode's instructions and tools need about 20k |
| `offgrid.chat.expertLayersOnCpu` | `0` | For MoE chat models larger than the GPU: run this many layers' experts on the CPU |
| `offgrid.cacheType` | `q8_0` | Context storage: `q8_0` (half the memory of `f16`), `f16` or `q4_0` |
| `offgrid.completion.contextSize` | `8192` | Code model context in tokens |
| `offgrid.gpu` | `true` | Off: run on the CPU only |
| `offgrid.serverPath` | | Use your own offgrid-server build |

## Bigger models

With a 16 GB GPU and 32 GB of RAM, **Qwen3-Coder 30B-A3B** (17.3 GB download) is much better than
the default in Agent mode. **offgrid: Set Up Models** lists it under *Large models*, says whether
this machine is big enough, and asks before downloading. It doesn't fit a 16 GB GPU, but as a
Mixture-of-Experts model it keeps part of its expert weights in RAM (`offgrid.chat.expertLayersOnCpu`,
set for you). On an RX 9070 XT it runs at about 35 tokens/s with a 32k context. You can switch
back to Qwen3 4B in the same list.

Any other GGUF chat model works too (*Use a GGUF file for chat*).

## Requirements

- Linux x86_64 (glibc 2.28+) or Windows x86_64
- About 7 GB of free GPU memory for both models at the default context sizes, or a recent CPU
  (slower). Lower `offgrid.chat.contextSize` for smaller GPUs; Ask mode works with 8192.

## Known limitations

- Small local models are much weaker than cloud models, especially in Agent mode.
- Completion only triggers at the end of a line (or before closing brackets and quotes).

## License

MIT

# offgrid: local AI

Code completion and chat in VS Code with models that run on your own machine. No account, no
API key and no cloud: after a one-time model download, nothing leaves your computer.

It is built on [offgrid](https://github.com/Pinta365/offgrid), which runs GGUF models through
llama.cpp on any GPU (Vulkan: AMD, NVIDIA, Intel) and falls back to the CPU.

## Features

- **Code completion**: suggestions as you type (ghost text; Tab accepts) from a code model with
  fill-in-the-middle, using the code before and after the cursor and code from files you recently
  visited.
- **Chat**: a local model in VS Code's Chat view. Pick **offgrid: Qwen3.5 4B** (or your setup's model) in the model picker;
  it works in Ask and Agent modes, with tool calling.
- **Bundled server**: the extension ships offgrid-server for your platform and starts it
  when needed. All VS Code windows share one server, so the models load once.

## Getting started

1. Install the extension. On first start it offers a setup to download (once). It checks this
   machine's GPU and RAM, marks what fits, and recommends one:

   | Setup | Chat model | Download | For |
   |---|---|---|---|
   | **Tiny** | Qwen3.5 0.8B | 1.3 GB | No dedicated GPU, or under 6 GB: fast code completion (Qwen2.5-Coder 0.5B); chat for simple questions |
   | **Small** | Qwen3.5 2B | 2.7 GB | 6 GB GPUs: code completion, chat and light Agent use (about 4 GB in use) |
   | **Standard** | Qwen3.5 4B | 4.1 GB | 8 GB GPUs and up: better answers (about 6 GB in use) |
   | **Large** | Qwen3.6 35B-A3B | 22.1 GB | 16 GB GPUs with 32 GB RAM: the best in Agent mode |

   Small, Standard and Large use Qwen2.5-Coder 1.5B for code completion.
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
| `offgrid.chat.model` | | A chat model (GGUF); empty: Qwen3.5 4B |
| `offgrid.chat.contextSize` | `32768` | Chat context in tokens; Agent mode's instructions and tools need about 20k |
| `offgrid.chat.expertLayersOnCpu` | `0` | For MoE chat models larger than the GPU: run this many layers' experts on the CPU |
| `offgrid.cacheType` | `q8_0` | Context storage: `q8_0` (half the memory of `f16`), `f16` or `q4_0` |
| `offgrid.completion.contextSize` | `8192` | Code model context in tokens |
| `offgrid.gpu` | `true` | Off: run on the CPU only |
| `offgrid.serverPath` | | Use your own offgrid-server build |

## Switching setups and models

**offgrid: Set Up Models** switches between setups at any time; downloaded models stay, so
switching back needs no download. Large's model doesn't fit a 16 GB GPU, but as a
Mixture-of-Experts model it keeps part of its expert weights in RAM (`offgrid.chat.expertLayersOnCpu`,
set for you); on an RX 9070 XT it runs at about 37 tokens/s with a 32k context. Models from earlier versions
(Qwen3 0.6B / 1.7B / 4B, Qwen3-Coder 30B) stay listed under *Choose models one by one* while downloaded.

Any other GGUF model works too (*Use a GGUF file for chat* / *for code completion*).

## Requirements

- Linux x86_64 (glibc 2.28+) or Windows x86_64
- A GPU with 6 GB or more (Small fits in about 5.2 GB), or a recent CPU (slower). Set Up Models
  says which setup fits.

## Known limitations

- Use **Local** chat sessions. Copilot CLI sessions send a much larger built-in prompt (instructions
  and tools) than local models' contexts hold, so they stop with "No response was returned" before
  reaching the model.
- Small local models are much weaker than cloud models, especially in Agent mode.
- Completion only triggers at the end of a line (or before closing brackets and quotes).

## License

MIT

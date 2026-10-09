# Third-party software and models

My Own AI is licensed under the GNU GPL v3.0 or later. It includes or downloads the following
projects, each under its own license.

## Bundled with the app

| Project | Use | License |
|---|---|---|
| [WebLLM](https://github.com/mlc-ai/web-llm) (with XGrammar) | In-browser models on WebGPU | Apache-2.0 |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) | Speech recognition, voices, embeddings | MIT |
| [phonemizer](https://github.com/xenova/phonemizer) / [eSpeak NG](https://github.com/espeak-ng/espeak-ng) | Text to phonemes for Piper voices | Apache-2.0 / **GPL-3.0** |
| [eSpeak NG Emscripten port](https://github.com/echogarden-project/espeak-ng-emscripten) (Echogarden), English and French data only (`public/espeak`) | Text to phonemes for the French voices | **GPL-3.0** |
| [Preact](https://preactjs.com) | Interface | MIT |
| [Comlink](https://github.com/GoogleChromeLabs/comlink), [idb](https://github.com/jakearchibald/idb) | Workers, storage | Apache-2.0, ISC |
| [PDF.js](https://github.com/mozilla/pdf.js) | Reading PDFs | Apache-2.0 |
| [KaTeX](https://katex.org) | Maths | MIT |
| [highlight.js](https://highlightjs.org) | Code highlighting | BSD-3-Clause |
| [Readability](https://github.com/mozilla/readability) | Reading web pages | Apache-2.0 |
| [fflate](https://github.com/101arrowz/fflate) | Skill .zip files | MIT |
| [Inter](https://rsms.me/inter/) | Typeface | SIL Open Font License 1.1 |
| [Tauri](https://tauri.app) and its plugins | Windows app | Apache-2.0 / MIT |
| [Capacitor](https://capacitorjs.com) | Android app | MIT |
| [Vite](https://vitejs.dev), [vite-plugin-pwa](https://vite-pwa-org.netlify.app) | Build | MIT |

## Downloaded when used

| Project | Use | License |
|---|---|---|
| [Pyodide](https://pyodide.org) (from jsDelivr) | Python in the code sandbox | MPL-2.0 |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) (CUDA runtime included) | Native models on Windows | MIT (CUDA: NVIDIA license) |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | Speech recognition on Windows | MIT |
| [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) | Image generation on Windows | MIT |
| MCP servers you add | Connectors | Their own |

## Models (downloaded on demand, never bundled)

| Model | License |
|---|---|
| Qwen2.5, Qwen3, Qwen3.5 (Alibaba Qwen) | Apache-2.0 |
| Llama 3.2, Hermes 3 (Meta Llama, Nous Research) | Llama 3.1 / 3.2 Community License |
| Phi-3.5 mini and vision (Microsoft) | MIT |
| SmolLM2 (Hugging Face) | Apache-2.0 |
| [Phonon-2](https://huggingface.co/FermionResearch/Phonon-2) (Fermion Research, from NVIDIA Parakeet TDT 0.6B v3) | CC BY 4.0 |
| [Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) (NVIDIA), [ONNX export](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx) by istupakov | CC BY 4.0 |
| Whisper large-v3-turbo (OpenAI) | MIT |
| all-MiniLM-L6-v2 (sentence-transformers) | Apache-2.0 |
| [Piper voices](https://huggingface.co/rhasspy/piper-voices) (Lessac, Ryan, Alba, Alan; French: Siwis, Tom) | See each voice's model card (Siwis: CC BY 4.0 dataset; Tom: AGPL-3.0) |
| Z-Image-Turbo (Tongyi-MAI), Qwen3-4B-Instruct text encoder, FLUX.1 VAE | Apache-2.0 |
| GGUF models you add from Hugging Face | Their own (check the model card) |

Using a model means accepting its license; some (like Llama) have conditions of their own.

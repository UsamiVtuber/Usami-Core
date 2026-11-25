# FL Studio Bridge + OpenUTAU Singing Co-Producer (`fl-studio` v1.5)

Integracao completa em **4 camadas** para a Usami atuar como coprodutora e vocalista no **FL Studio 2026** + **OpenUTAU** (Windows, 100% gratuito e zero GPU):
1. **Camada 1 — API MIDI/SysEx (`device_usami.py`, ~2 ms):** estado, transport, mixer, Sidechain ghost, EQ/Mono, Step Sequencer half-time, ~200 parametros VST (`fl.plugin`), notas ao vivo e undo.
2. **Camada 2 — Geracao de Arquivos & Indexacao de Presets (~30 ms):** exportacao `.mid` + `UsamiImportScore.pyscript` no Piano Roll (`fl.midi_file`), indexador `XferJson` dos seus `.SerumPreset` do **Serum 2** (`fl.serum`), escuta espectral **WASAPI Loopback** (`fl.listen`) e enciclopedia/memoria de estudio (`fl.guide`, `fl.learn`).
3. **Camada 3 — Canto no OpenUTAU (Modo Vocaloid `Usami_CV` + Modo Neuro-sama `DiffSinger` + `Seed-VC` / `RVC v2`):**
   - **Modo Vocaloid (`engine: "classic"`):** usa o voicebank nativo `Usami_CV` (112 amostras `44.1 kHz / F4`, resampler `WORLDLINE-R` em CPU).
   - **Modo Neuro-sama (`engine: "diffsinger"` + `action: "convert"` ou RVC v2):** renderiza uma guia vocal neural expressiva em Portugues/Japones/Ingles no OpenUTAU usando `Evelyn DS v110` (credito: Team BRAPA + Misc Labs, uso pessoal nao-comercial) + vocoder `PC-NSF-HiFiGAN` em CPU (ONNX), e converte o `.wav` exportado no timbre exato da Usami via **Seed-VC F0** (`action: "convert"` na GPU gratuita do Hugging Face) ou via modelo **RVC v2** treinado no notebook `tools/rvc/train_and_sing_usami_rvc_v2.ipynb` com `data/rvc/usami_rvc_dataset_30min.zip`.
4. **Camada 4 — Automacao de UI / Mouse / Teclado com Kill-Switch (`fl.ui`, Nivel 3):** carrega geradores da `Plugin database` via `F8` (`Serum 2`, `Harmor`, `Sytrus`, `Sakura`, `Ogun`, `Kepler Exo`, `3x Osc`, `Patcher`, `Slicex`), envia atalhos (`Ctrl+L` para rotear ao Mixer), captura screenshots PNG DPI-aware e executa cliques/drags apenas dentro do `FL64.exe` — **abortando imediatamente se voce apertar `ESC` ou mexer o mouse fisico**.

## Setup rapido (loopMIDI + FL Studio 2026 + OpenUTAU)

1. No **loopMIDI**, crie `Usami-To-FL` e `FL-To-Usami`.
2. Em `usami/`, rode `npm run fl:install` e `npm run fl:voicebank`.
3. Em **FL Studio 2026 -> Options -> MIDI Settings**:
   - **Output**: `FL-To-Usami` -> **Port = 10**.
   - **Input**: `Usami-To-FL` -> **Enable**, **Controller type = `Usami Companion Bridge`**, **Port = 10**.
   - Em **Audio Settings**, use **FL Studio ASIO**.
4. Para cantar com o **OpenUTAU**: peca a Usami (texto ou voz) *"faz a Usami cantar 'vem brilhar comigo' em F a 156 BPM e abre no OpenUTAU"*. No OpenUTAU, aperte `Espaco` para ouvir e `File -> Export Audio -> Export Wav Files` para jogar a acapella na Playlist do FL Studio.

## As 16 ferramentas da skill `fl-studio`

- `fl.state` (Nivel 1): BPM, transport, pattern, Channel Rack e Mixer com picos/clipping.
- `fl.listen` (Nivel 1): escuta WASAPI Loopback (ou `.wav`) com LUFS, 6 bandas, fase mono do Sub e metas por subgenero.
- `fl.guide` (Nivel 1): receitas para Serum 2 (Spectral/Granular/FM), Harmor, Ogun, Sytrus, Sakura, Vocodex e Patcher + notas aprendidas.
- `fl.learn` (Nivel 2): memoriza tecnicas e preferencias em `data/fl-producer-notes.json`.
- `fl.serum` (Nivel 2): busca nos `.SerumPreset` do Serum 2 por nome/categoria/tag (`Spectral`, `Granular`, `Wavetable`) e separa bancos em `Presets/User/Usami/`.
- `fl.vocal` (Nivel 2): compoe vocais `.ustx` + `.ust` + `.mid` sincronizados ao BPM/escala para o **OpenUTAU** com o voicebank `Usami_CV`.
- `fl.ui` (Nivel 3): automacao segura de teclado/mouse/captura no FL Studio com kill-switch (`ESC` + deteccao de movimento manual do mouse).
- `fl.transport`, `fl.mixer`, `fl.routing`, `fl.eq`, `fl.steps`, `fl.plugin`, `fl.midi`, `fl.midi_file`, `fl.undo` (Nivel 2).

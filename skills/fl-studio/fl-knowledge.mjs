/**
 * Base de Conhecimento Tecnico de Producao Musical da Usami para FL Studio 2026
 * focada em: Future Bass, Kawaii Future Bass, Dubstep, Riddim, Brostep,
 * Colour Bass e Melodic Dubstep.
 *
 * Modulo 100% puro (sem I/O, sem rede, compativel com sandbox --permission).
 */

export const KNOWLEDGE_TOPICS = Object.freeze([
  'all',
  'sound_design',
  'drums',
  'harmony',
  'mixing',
  'fl_tricks',
  'arrangement',
]);

export const KNOWLEDGE_GENRES = Object.freeze([
  'future_bass',
  'kawaii',
  'dubstep',
  'riddim',
  'brostep',
  'colour_bass',
  'melodic_dubstep',
  'general',
]);

export const LEARN_ACTIONS = Object.freeze(['save', 'list', 'delete']);
export const SERUM_ACTIONS = Object.freeze(['search', 'categories', 'stage', 'create']);
export const SERUM_STYLES = Object.freeze([
  'supersaw',
  'growl',
  'riddim_square4',
  'colour_bass',
  'kawaii_pluck',
  'reese',
]);
export const UI_ACTIONS = Object.freeze([
  'inspect_windows',
  'capture_window',
  'add_plugin',
  'shortcut',
  'mouse_click',
  'knob_drag',
  'mouse_drag',
]);
export const UI_SHORTCUTS = Object.freeze([
  'open_plugin_picker',
  'toggle_playlist',
  'toggle_channel_rack',
  'toggle_piano_roll',
  'toggle_mixer',
  'assign_free_mixer_track',
  'clone_channel',
  'save_project',
]);

export const GENRE_PLAYBOOKS = Object.freeze({
  future_bass: Object.freeze({
    id: 'future_bass',
    name: 'Future Bass',
    artistsRef: ['Flume', 'Illenium (early)', 'San Holo', 'Grant', 'MYRNE'],
    bpmRange: [140, 160],
    targetLufsDrop: [-7.5, -4.5],
    sound_design: [
      'Supersaw Wall em 3 camadas: (1) Mid Saw 5-7 vozes com detune baixo (0.08-0.14 no Vital/Serum) focada em 200-1500 Hz para definicao; (2) Wide Saw 16 vozes com detune mais aberto (0.18-0.25) e HPF em 220 Hz para largura; (3) Sub separado em onda Senoidal/Triangular abaixo de 110 Hz com leve saturacao de 2o/3o harmonico.',
      'Movimento de Pump/Wobble nos acordes: module o Cutoff de um filtro Lowpass MG 12/24 dB + nivel de volume com um LFO em 1/8, 1/4 ou envelope retrigger a cada chop MIDI (usando fl.midi_file style=future_bass_pump).',
      'Camada de Brilho (Top Noise): adicione White/Pink Noise ou foley texturizado seguindo exatamente o mesmo gate/envelope dos acordes de supersaw, cortado abaixo de 2 kHz.',
      'Leads: square/saw hibrido com glide/portamento de 35-65 ms, vibrato atrasado por macro e ott leve (20-30% depth) seguido de reverb curto em send.',
    ],
    drums: [
      'Groove Half-Time: Kick sincopado conversando com os ataques dos acordes (preset future_bass_kick: steps [0, 3, 6, 10, 14]) e Snare/Clap estalado com corpo em ~200 Hz no tempo 3 (preset halftime_snare: step 8).',
      'Hi-hats e Toms: rolls em 1/16 e tercinas (1/12, 1/24) com automacao de pitch e pan antes do snare; fills de toms acusticos/eletronicos nos finais de 4 e 8 compassos.',
    ],
    harmony: [
      'Acordes com extensoes ricas: maj7, maj9, m9, m11 e add9 em voicing supersaw (progressao future_bass_anthem: vi9 - IVmaj9 - Imaj7 - Vadd9).',
      'Evite tercas graves abaixo de C3 (MIDI 48): mantenha fundamental + 5a no grave e abra 3a, 7a e 9a nas oitavas 4 e 5.',
    ],
    mixing: [
      'Sidechain cirurgico e rapido (35-65 ms de release): os acordes precisam abrir logo apos o transiente do Kick/Snare para manter impacto sem perder o corpo do acorde.',
      'Sub 100% Mono abaixo de 110 Hz (fl.eq preset=sub_mono_clean); corte tudo abaixo de 120-150 Hz no Chord Bus para nao brigar com o Sub.',
    ],
    fl_tricks: [
      'Use fl.routing (mode=sidechain) do Kick e da Snare para o Chord Bus e Sub, e insira Fruity Limiter em modo COMP (Sidechain 1, Ratio 6:1, Attack 0.1 ms, Release 45 ms) ou Gross Beat / Fruity Love Philter para curvas de volume.',
      'No Piano Roll, use Slide Notes nativas do FL Studio (triangulo ativado no canto superior esquerdo do Piano Roll) em synths nativos como Sytrus/FLEX/Harmor para bends de acorde inteiros.',
    ],
    arrangement: [
      'Intro atmosferica (8 bars) -> Verse com vocal/pluck filtrado (16 bars) -> Buildup com snare roll 1/4->1/8->1/16->1/32 e filtro abrindo + 1 compasso de silencio seco no pre-drop -> Drop 1 (16 bars, mudando o ritmo do LFO na barra 9).',
    ],
  }),

  kawaii: Object.freeze({
    id: 'kawaii',
    name: 'Kawaii Future Bass',
    artistsRef: ["Snail's House", 'Yunomi', 'Moe Shop', 'Kotori', 'Hyper Potions', 'Ujico*'],
    bpmRange: [150, 172],
    targetLufsDrop: [-8.0, -5.0],
    sound_design: [
      'Lead Chiptune / Square fofo: onda Square (duty cycle 50% ou 25% estilo NES/GameBoy) com ataque rapido, pitch envelope subindo +12 semitons nos primeiros 20-35 ms ("blip" de videogame) e chorus/hyper suave.',
      'Plucks cintilantes: sobreponha Music Box, Kalimba, Celesta, Marimba ou FM Bell (Sytrus/Vital) aos ataques dos acordes para dar transiente cristalino sem precisar esmagar no agudo.',
      'Supersaws mais leves e doces: menos distorcao agressiva em 2-4 kHz do que no Dubstep; corte ressonancias duras em ~3.2 kHz e abra ar suave acima de 8-10 kHz.',
      'Vocal Chops Kawaii: picote silabas curtas e suba o pitch (+5 a +12 st) ajustando o Formant para cima para timbre anime brilhante sem ficar metalico.',
    ],
    drums: [
      'Kick curto, arredondado e saltitante (preset kawaii_bounce_kick: [0, 3, 7, 10, 12, 15]) + Clap/Snare estalado e agudo no step 8.',
      'Ear Candy & Foley nos contratempos (preset kawaii_perc: [2, 5, 9, 11, 14]): bed squeaks (mola de cama), gota dagua, moeda 8-bit, lata abrindo, sino de bicicleta, shaker e woodblocks.',
    ],
    harmony: [
      'Progressao Royal Road (Oudou Shinkou): IVmaj7 - V7 - iii7 - vi9 (ex. em Fa: Bbmaj7 - C7 - Am7 - Dm9; preset kawaii_royal_road e kawaii_sparkle).',
      'Temperos de J-Pop/Anime: acordes 6/9 (C69), 9sus4 (V9sus4 antes de resolver), dominante secundario III7 indo para vi9 (ex.: E7 -> Am9 em Do maior) e diminuto de passagem (#ivdim7).',
      'Arpejos rapidos em 1/16 e 1/32 nas oitavas 5 e 6 (fl.midi_file style=kawaii_arp).',
    ],
    mixing: [
      'Mix clara e saltitante: evite comprimir demais o Master (mantenha Crest Factor entre 6 e 9 dB) para preservar o bounce das percussoes e plucks.',
      'Panning criativo: espalhe os foleys, bells e percussao kawaii entre 35% L e 35% R para criar palco largo e divertido.',
    ],
    fl_tricks: [
      'Use Fruity Slicex ou Fruity Granulizer para fatiar frases vocais + Pitcher com Formant ligado para vocal chops estilo anime.',
      'Use 3x Osc com duas ondas Square + Pitch Envelope (Amt +12 st, Decay bem curto) para leads 8-bit instantaneos com zero CPU.',
      'No seu arsenal do FL Studio: use Sakura para plucks de Koto/cordas japonesas, Sytrus para FM Bells cristalinos, SoundFont Player para timbres de SNES/GBA e Kepler Exo para acordes vintage quentes.',
    ],
    arrangement: [
      'Troque o elemento de destaque a cada 2 ou 4 compassos no drop (chamada de Lead 8-bit -> resposta de Vocal Chop -> fill de Piano/Jazz lick -> retomada de Supersaw).',
    ],
  }),

  riddim: Object.freeze({
    id: 'riddim',
    name: 'Riddim Dubstep',
    artistsRef: ['Infekt', 'Subfiltronik', 'chibs', 'Virtual Riot (Riddim sets)', 'SVDDEN DEATH'],
    bpmRange: [140, 145],
    targetLufsDrop: [-5.8, -3.0],
    sound_design: [
      'Square4 / Metallic Synth: no Serum ou Vital, use wavetable Basic Shapes (Square) + FM sutil de um segundo oscilador (Sine/Square +1 ou +2 oitavas, FM 20-35%).',
      'O segredo do timbre de Riddim e o filtro: passe por Comb Filter (Comb+/Comb-), Flanger- ou Phaser/Allpass com ressonancia alta, modulando sutilmente o Cutoff e o Mix pelo mesmo LFO principal.',
      'LFO em 1/4 ou 1/4T (tercina): desenhe curva com ataque levemente atrasado ("wonk" / "yoi") para dar o swing hipnotico; mapeie um Macro para a posicao do filtro Comb para criar 4 variacoes do mesmo som.',
      'Pos-processamento: OTT (Depth 35-55%, puxe um pouco High e Mid pra cima) -> Delay curtissimo (8-18 ms, feedback 20-35% para ressonancia metalica) -> Soft Clipper / Hard Clipper.',
    ],
    drums: [
      'Bateria minimalista e seca: Kick curto e punchy + Clap/Snare curto batendo JUNTOS ou no tempo 3 (presets riddim_stomp [0, 8] e riddim_kick [0, 14]).',
      'Swing no Hi-Hat: chimbais abertos/fechados com groove em tercinas ou offbeat (riddim_triplet_hat: [0, 3, 6, 8, 11, 14]) ditam o balanco da pista.',
    ],
    harmony: [
      'Monofonico e atonal/frigio: focado em 1 nota fundamental grave (D#, E, F ou F#) com saltos de +1 semitom (2a menor frigia) ou oitava nos finais de frase (preset riddim_dark e style=riddim_bass).',
    ],
    mixing: [
      'Separe Sub de Mid-Bass: mantenha um Sub senoidal limpo e 100% Mono abaixo de 100 Hz (com harmonicos leves em 100-180 Hz) e corte abaixo de 110 Hz no synth metalico para que o Comb Filter/Delay curto nao destrua a fase do grave.',
      'Sidechain total (ducking de 100% curtissimo, 40-60 ms) no Sub e Mid-Bass a cada batida de Kick+Clap para abrir espaco total pro transiente.',
    ],
    fl_tricks: [
      'No FL Studio, Fruity Delay 3 com Time em 5-15 ms (Keep Pitch desligado, Stereo Offset 0, Feedback ~30%) cria timbres metalicos absurdos de Riddim em qualquer synth.',
      'Use Fruity Waveshaper ou Fruity Soft Clipper no fim do Bass Bus para segurar picos em 0 dB e ganhar volume aparente (LUFS alto sem amassar o punch).',
      'No seu arsenal: use Serum 2 (Osc Square + Dual Filter Comb+ / Allpass) como synth principal e sobreponha Ogun (sintese aditiva de 32.767 harmonicos metalicos, HPF em 400 Hz) para criar transientes de espada/metal unicos no Riddim.',
    ],
    arrangement: [
      'Groove repetitivo hipnotico (Call & Response de 2 compassos): Compasso 1-2 = Bass Principal no flow 1/4; Compasso 2 beat 4 = turnaround/pitch jump; Compasso 5 ou 9 = fakeout (silencio + vocal sample curto) -> volta dobrando ou invertendo o LFO ("VIP switch").',
    ],
  }),

  brostep: Object.freeze({
    id: 'brostep',
    name: 'Brostep / Heavy Dubstep',
    artistsRef: ['Skrillex', 'Virtual Riot', 'Zomboy', 'Barely Alive', 'Must Die!'],
    bpmRange: [145, 150],
    targetLufsDrop: [-5.8, -3.0],
    sound_design: [
      'FM Growls Falantes: Osc A wavetable complexa/monster (oitava -2) modulada via FM from B (Osc B Sine ou Harmonic series em +1 ou +2 oitavas, nivel 35-48%).',
      'Vogais (Formants): use filtro Formant (AOIE) ou dois picos/notches moveis em EQ (250-900 Hz e 1000-2800 Hz) movendo em direcao oposta ao LFO para som de "yoi/growl" vocal.',
      'Screeches / Lasers: wavetable aguda (+1/+2 oitavas), Sync ou Bend+/- modulado por LFO rapido (1/16 ou 1/32) + pitch envelope caindo rapido + OTT + Reverb curto antes do clipper.',
      'Reese / Sustain Bass: saw desafinada com notch phaser e distorcao pesada para preencher sustenidos tensos.',
    ],
    drums: [
      'Kick e Snare gigantes: Kick com fundamental em 50-60 Hz e clique nitido em 3-5 kHz (preset brostep_kick: [0, 6, 15]); Snare pesada com corpo tonal em 185-210 Hz + camada de clap/white noise + cauda de reverb gated de ~180 ms no step 8.',
      'Rides/Crashes no segundo meio do drop (barra 9 em diante) batendo em todas as seminimas (0, 4, 8, 12) para dobrar a energia.',
    ],
    harmony: [
      'Escala Menor Harmonica ou Frigia Dominante: tensao de meio-tom (i - bII, V7 -> i; preset brostep_drop e style=brostep_riff).',
    ],
    mixing: [
      'Controle de rispidez (2.5-5 kHz): distorcao FM + OTT empilham muita energia cortante nessa faixa; use notches cirurgicos ou compressao dinamica antes do Master.',
      'Edicao em Audio (Resampling): no Brostep muitos produtores exportam frases de growl em WAV para cortar caudas no zero-crossing, deixando silencio absoluto de 20-40 ms entre um bass e outro (contraste extremo aumenta o impacto).',
    ],
    fl_tricks: [
      'Monte um Patcher no Bass Bus com Frequency Splitter em 120 Hz: banda baixa vai limpa em Mono direto para a saida; banda media/alta recebe Fruity Blood Overdrive / Waveshaper + Chorus + OTT.',
      'No seu arsenal: use Serum 2 (FM entre Osc A/B + filtro Formant), Sytrus (Matriz FM de 6 operadores: Op 2 e 3 modulando Op 1 com ratios 2:1 e 4:1 para growls rasgados) e Harmor (Resynthesis de um sample de growl com Prism/Phaser harmonico).',
    ],
    arrangement: [
      'Drop em mosaico de timbres: Barra 1 Downbeat (Impacto/Sub drop) -> Barra 1-2 Growl A -> Barra 2 beat 4 Screech fill -> Barra 3-4 Resposta rapida 1/8 -> Barra 4 Drum fill -> Barra 5-8 variacao com oitava acima.',
    ],
  }),

  colour_bass: Object.freeze({
    id: 'colour_bass',
    name: 'Colour Bass',
    artistsRef: ['Chime', 'Ace Aura', 'Sharks', 'Skybreak', 'Papa Khan'],
    bpmRange: [142, 150],
    targetLufsDrop: [-6.8, -4.0],
    sound_design: [
      'Conceito central do Colour Bass: fundir o impacto e a textura ritmica de growls/basses agressivos de Dubstep com a harmonia rica e cristalina de acordes estendidos (m11, maj9, maj11, 6/9).',
      'Metodo 1 — Vocoder (100% nativo no FL Studio com Vocodex!): grave/rode um Bass agressivo e ruidoso (Modulator) + um synth de acordes brilhantes tipo Supersaw rica em agudos (Carrier, usando voicing=colour_bass) dentro do Vocodex com 80-100 bandas finas.',
      'Metodo 2 — Resonator / Delay Tunado: passe um growl metalico por delays curtissimos afinados nas notas do acorde (ex.: C, G, Bb, D, F) ou convolucao com sample curto de acorde (Fruity Convolver carregado com um stab curto de supersaw/piano!).',
      'Camada de Textura Liquida: dispersao de fase (allpass filters em serie), frequency shifting sutil, arpejos granulares agudos e OTT para puxar os harmonicos cristalinos para frente.',
    ],
    drums: [
      'Groove apertado e sincopado (preset colour_bass_kick: [0, 6, 11, 14] + halftime_snare no 8), deixando espaco nos medios para as caudas coloridas respirarem; snare cristalina com transiente claro.',
    ],
    harmony: [
      'Extensoes super coloridas: m11, maj9, maj11 (#11 Lidio!), 6/9 e mudancas cromaticas de acordes maiores/menores fora da escala tradicional (planing harmonico; preset colour_bass_prism).',
      'Use SEMPRE voicing=colour_bass no fl.midi_file (style=sustained): ele remove tercas emboladas do grave e abre 7a/9a/11a nas oitavas 4-5 para o vocoder/resonador soar cristalino.',
    ],
    mixing: [
      'REGRA DE OURO DO COLOUR BASS: NUNCA passe o Sub grave (< 110 Hz) por dentro do Vocoder, Resonator ou Convolver — isso destroi a fase e o peso do grave! Corte o bass colorido em 120 Hz (HPF) e mantenha um canal de Sub Senoidal 100% Mono separado tocando a nota fundamental.',
      'Cuide do brilho em 6-16 kHz (Air) sem deixar ressonancias apitando em 3-5 kHz (quando usar convolver/resonador, aplique Soothe/EQ dinamico ou corte picos agudos estreitos).',
    ],
    fl_tricks: [
      'Receita exata do Vocodex no FL Studio 2026: Track 10 = Growl Bass (desconecte do Master e envie para Track 12); Track 11 = Supersaw Chords (faca Sidechain ghost com fl.routing mode=sidechain para Track 12); Track 12 = Vocodex (no topo do Vocodex coloque Modulator = 0 e Carrier = 1 [Supersaw], 90 bandas, Bandwidth ~25%, Wet 100%, Soundgoodizer/OTT depois!).',
      'Truque do Fruity Convolver: arraste um acorde curto (200 ms) de Supersaw ou Bell para dentro do Fruity Convolver inserido num canal de Growl Bass (Dry 15%, Wet 85%, estique/encurte o Stretch) — transforma qualquer growl em Colour Bass instantaneo!',
      'No seu arsenal: o Serum 2 possui Oscilador Spectral e Granular nativos (carregue um sample de growl no Osc Spectral com filtragem harmonica), e o Harmor (knobs Prism + Harmonizer + Phaser em escala harmonica) mais o Ogun sao lendarios no Colour Bass sem precisar comprar plugins externos!',
    ],
    arrangement: [
      'Alterne compassos de acorde colorido cheio com fills secos/atonais curtos para valorizar o contraste quando a cor harmonica entra.',
    ],
  }),

  melodic_dubstep: Object.freeze({
    id: 'melodic_dubstep',
    name: 'Melodic Dubstep',
    artistsRef: ['Seven Lions', 'Illenium', 'Au5', 'Trivecta', 'Last Heroes', 'Crystal Skies'],
    bpmRange: [140, 150],
    targetLufsDrop: [-6.8, -4.0],
    sound_design: [
      'Wall of Sound (5 camadas coesas): (1) Sub Senoidal Mono (< 100 Hz); (2) Mid Gritty Reese/Saw Bass (100-350 Hz, distorcido para dar peso e raiva aos acordes); (3) Core Supersaw (7 vozes, medio cheio); (4) Wide Detuned Supersaw + Strings/Choir sintetico (16 vozes, aberto no estereo); (5) Top Lead/Arp dobrando a melodia no agudo + White Noise.',
      'Growl Fills: nos espacos entre os acordes (ex.: final da barra 2, barra 4 inteira, barra 8), a parede de acordes corta seco e entra um fill pesado de Brostep/Au5 growl.',
    ],
    drums: [
      'Bateria epica cinematografica: Kick encorpado (preset melodic_dubstep_kick: [0, 3, 10, 14]), Snare em camadas (corpo punchy + clap largo + cauda de hall reverb grande no step 8) e crashes largos no inicio de cada acorde.',
    ],
    harmony: [
      'Progressoes emocionais epicas em tom menor/relativo maior (preset melodic_dubstep_epic: im9 - bVImaj7 - bIIIadd9 - bVIIsus4, ex. em Am: Am9 - Fmaj7 - Cadd9 - Gsus4).',
      'Notas pedais no agudo: mantenha a tonica ou a 5a cantando fixa no topo enquanto os baixos mudam embaixo para aumentar a emocao.',
    ],
    mixing: [
      'Automacao de Reverb (Reverb Ducking): paredes gigantes de Supersaw + Snare Hall viram uma sopa embolada se a cauda do reverb invadir o proximo acorde ou fill de growl — faça sidechain do Reverb pelo proprio sinal dry ou zere o Wet nos cortes secos.',
      'Cole todas as camadas harmonicas num unico Chord Bus com compressao glue leve, EQ cortando abaixo de 110 Hz (deixando o Sub reinar sozinho) e Sidechain forte do Kick e da Snare.',
    ],
    fl_tricks: [
      'Agrupe todas as camadas de Supersaw, Arp e Choir em uma track "Chord Bus" usando fl.routing (mode=bus_only) e aplique um unico Sidechain do Kick/Snare no Bus todo — assim todas as camadas respiram juntas como um instrumento so.',
      'Use fl.midi_file (style=melodic_dubstep_stack, voicing=supersaw) para gerar os blocos half-time ja com antecipacao ritmica.',
    ],
    arrangement: [
      'Estrutura cinematica: Verse intimo (piano/violao + vocal) -> Pre-Chorus crescendo -> Buildup emocional com melodia principal anunciada -> Drop 1 (Wall of Sound + Growl fills nos compassos 4 e 8) -> Breakdown orquestral -> Drop 2 (variacao melódica ou trecho rapido 4-on-the-floor Psy/DnB no meio antes de voltar ao half-time final).',
    ],
  }),
});

function normalizeSearch(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_+#/-]+/g, ' ')
    .trim();
}

export function validateGuideArgs(args = {}) {
  const out = {};
  if (args.genre !== undefined) {
    const g = String(args.genre).trim().toLowerCase();
    if (!KNOWLEDGE_GENRES.includes(g)) {
      throw new Error(`genre invalido: "${args.genre}". Use um de: ${KNOWLEDGE_GENRES.join(', ')}.`);
    }
    out.genre = g;
  }
  const topic = String(args.topic || 'all').trim().toLowerCase();
  if (!KNOWLEDGE_TOPICS.includes(topic)) {
    throw new Error(`topic invalido: "${args.topic}". Use um de: ${KNOWLEDGE_TOPICS.join(', ')}.`);
  }
  out.topic = topic;
  if (args.query !== undefined) {
    const q = String(args.query).trim().slice(0, 200);
    if (q) out.query = q;
  }
  return out;
}

export function validateLearnArgs(args = {}) {
  const action = String(args.action || 'save').trim().toLowerCase();
  if (!LEARN_ACTIONS.includes(action)) {
    throw new Error(`action invalida: "${args.action}". Use save, list ou delete.`);
  }
  const out = { action };
  if (args.genre !== undefined) {
    const g = String(args.genre).trim().toLowerCase();
    if (!KNOWLEDGE_GENRES.includes(g)) {
      throw new Error(`genre invalido: "${args.genre}". Use um de: ${KNOWLEDGE_GENRES.join(', ')}.`);
    }
    out.genre = g;
  }
  if (args.topic !== undefined) {
    const t = String(args.topic).trim().toLowerCase();
    if (!KNOWLEDGE_TOPICS.includes(t)) {
      throw new Error(`topic invalido: "${args.topic}". Use um de: ${KNOWLEDGE_TOPICS.join(', ')}.`);
    }
    out.topic = t;
  }

  if (action === 'save') {
    const title = String(args.title ?? '').trim().slice(0, 120);
    const content = String(args.content ?? '').trim().slice(0, 1200);
    if (title.length < 3) {
      throw new Error('title deve ter ao menos 3 caracteres para salvar aprendizado.');
    }
    if (content.length < 5) {
      throw new Error('content deve ter ao menos 5 caracteres para salvar aprendizado.');
    }
    out.title = title;
    out.content = content;
    out.genre = out.genre || 'general';
    out.topic = out.topic && out.topic !== 'all' ? out.topic : 'sound_design';
    out.source = String(args.source || 'user').trim().slice(0, 32) || 'user';
  } else if (action === 'delete') {
    const noteId = String(args.noteId ?? '').trim();
    if (!noteId) {
      throw new Error('noteId e obrigatorio para action=delete.');
    }
    out.noteId = noteId;
  } else if (args.query !== undefined) {
    const q = String(args.query).trim().slice(0, 200);
    if (q) out.query = q;
  }
  return out;
}

export function validateSerumArgs(args = {}) {
  const action = String(args.action || 'search').trim().toLowerCase();
  if (!SERUM_ACTIONS.includes(action)) {
    throw new Error(`action invalida em fl.serum: "${args.action}". Use search, categories, stage ou create.`);
  }
  const out = { action };
  if (args.query !== undefined) {
    const q = String(args.query).trim().slice(0, 120);
    if (q) out.query = q;
  }
  if (args.category !== undefined) {
    const c = String(args.category).trim().slice(0, 48);
    if (c) out.category = c;
  }
  if (args.tag !== undefined) {
    const t = String(args.tag).trim().slice(0, 48);
    if (t) out.tag = t;
  }
  if (args.limit !== undefined) {
    if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 30) {
      throw new Error('limit deve ser inteiro entre 1 e 30.');
    }
    out.limit = args.limit;
  }
  if (args.bankName !== undefined) {
    const b = String(args.bankName).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
    if (b) out.bankName = b;
  }
  if (action === 'stage') {
    if (Array.isArray(args.presetNames) && args.presetNames.length > 0) {
      out.presetNames = args.presetNames.map(s => String(s ?? '').trim().slice(0, 120)).filter(Boolean);
    }
    if (!out.presetNames?.length && !out.query && !out.category) {
      throw new Error('Informe presetNames, query ou category para action=stage.');
    }
  } else if (action === 'create') {
    const style = String(args.style || 'supersaw').trim().toLowerCase();
    if (!SERUM_STYLES.includes(style)) {
      throw new Error(`style invalido em fl.serum create: "${args.style}". Use: ${SERUM_STYLES.join(', ')}.`);
    }
    out.style = style;
    const rawName = String(args.presetName || `Usami - ${style}`).trim().slice(0, 64);
    out.presetName = rawName || `Usami - ${style}`;

    const overrides = {};
    if (args.unison !== undefined) {
      const u = Math.round(Number(args.unison));
      if (!Number.isInteger(u) || u < 1 || u > 16) throw new Error('unison deve ser inteiro entre 1 e 16.');
      overrides.unison = u;
    }
    for (const unitKey of ['detune', 'filterFreq', 'filterReso', 'filterDrive']) {
      if (args[unitKey] !== undefined) {
        const num = Number(args[unitKey]);
        if (!Number.isFinite(num) || num < 0 || num > 1) {
          throw new Error(`${unitKey} deve ser numero entre 0.0 e 1.0.`);
        }
        overrides[unitKey] = num;
      }
    }
    if (args.octave !== undefined) {
      const oct = Math.round(Number(args.octave));
      if (!Number.isInteger(oct) || oct < -4 || oct > 4) throw new Error('octave deve estar entre -4 e 4.');
      overrides.octave = oct;
    }
    if (args.subEnable !== undefined) overrides.subEnable = Boolean(args.subEnable);
    if (args.mono !== undefined) overrides.mono = Boolean(args.mono);
    if (Object.keys(overrides).length > 0) out.overrides = overrides;
  }
  return out;
}

export function validateUiArgs(args = {}) {
  const action = String(args.action || 'inspect_windows').trim().toLowerCase();
  if (!UI_ACTIONS.includes(action)) {
    throw new Error(`action invalida em fl.ui: "${args.action}". Use um de: ${UI_ACTIONS.join(', ')}.`);
  }
  const out = { action };
  if (args.windowTitle !== undefined) {
    const wt = String(args.windowTitle).trim().slice(0, 120);
    if (wt) out.windowTitle = wt;
  }

  if (action === 'add_plugin') {
    const p = String(args.pluginName ?? '').trim().slice(0, 80);
    if (!p) throw new Error('pluginName e obrigatorio para action=add_plugin (ex.: Serum 2, Harmor, Sytrus, Sakura, Ogun).');
    out.pluginName = p;
  } else if (action === 'shortcut') {
    const sc = String(args.shortcut ?? '').trim().toLowerCase();
    if (!UI_SHORTCUTS.includes(sc)) {
      throw new Error(`shortcut invalido: "${args.shortcut}". Use um de: ${UI_SHORTCUTS.join(', ')}.`);
    }
    out.shortcut = sc;
  } else if (action === 'mouse_click') {
    if (!Number.isInteger(args.relX) || !Number.isInteger(args.relY) || args.relX < 0 || args.relY < 0) {
      throw new Error('relX e relY devem ser inteiros >= 0 relativos a janela do FL Studio.');
    }
    out.relX = args.relX;
    out.relY = args.relY;
    if (args.button !== undefined) {
      if (args.button !== 'left' && args.button !== 'right') {
        throw new Error('button deve ser left ou right.');
      }
      out.button = args.button;
    }
    if (args.double !== undefined) out.double = Boolean(args.double);
  } else if (action === 'knob_drag') {
    if (!Number.isInteger(args.relX) || !Number.isInteger(args.relY) || args.relX < 0 || args.relY < 0) {
      throw new Error('relX e relY devem ser inteiros >= 0 relativos a janela.');
    }
    const deltaPx = args.deltaPx === undefined ? -60 : Number(args.deltaPx);
    if (!Number.isInteger(deltaPx) || deltaPx === 0 || Math.abs(deltaPx) > 250) {
      throw new Error('deltaPx deve ser inteiro diferente de zero entre -250 e 250.');
    }
    out.relX = args.relX;
    out.relY = args.relY;
    out.deltaPx = deltaPx;
  } else if (action === 'mouse_drag') {
    for (const k of ['fromRelX', 'fromRelY', 'toRelX', 'toRelY']) {
      if (!Number.isInteger(args[k]) || args[k] < 0) {
        throw new Error(`${k} deve ser inteiro >= 0.`);
      }
      out[k] = args[k];
    }
  }
  return out;
}

export function queryGenreKnowledge({ genre = null, topic = 'all', query = '', customNotes = [] } = {}) {
  const selectedKeys = genre && genre !== 'general' && GENRE_PLAYBOOKS[genre]
    ? [genre]
    : Object.keys(GENRE_PLAYBOOKS);

  const sectionFields = topic === 'all'
    ? ['sound_design', 'drums', 'harmony', 'mixing', 'fl_tricks', 'arrangement']
    : [topic];

  const queryTokens = normalizeSearch(query).split(/\s+/).filter(w => w.length >= 2);

  const playbooks = selectedKeys.map(key => {
    const pb = GENRE_PLAYBOOKS[key];
    const sections = {};
    let relevance = genre === key ? 10 : 0;

    for (const sec of sectionFields) {
      const items = pb[sec] || [];
      sections[sec] = items;
      if (queryTokens.length > 0) {
        const hay = normalizeSearch(`${pb.name} ${pb.artistsRef.join(' ')} ${items.join(' ')}`);
        for (const tok of queryTokens) {
          if (hay.includes(tok)) relevance += 2;
        }
      }
    }

    return {
      genre: pb.id,
      name: pb.name,
      artistsRef: pb.artistsRef,
      bpmRange: pb.bpmRange,
      targetLufsDrop: pb.targetLufsDrop,
      sections,
      _relevance: relevance,
    };
  });

  if (queryTokens.length > 0 && !genre) {
    playbooks.sort((a, b) => b._relevance - a._relevance);
  }

  // Filtra notas aprendidas personalizadas
  const matchedNotes = (Array.isArray(customNotes) ? customNotes : []).filter(note => {
    if (genre && genre !== 'general' && note.genre && note.genre !== 'general' && note.genre !== genre) {
      return false;
    }
    if (topic && topic !== 'all' && note.topic && note.topic !== topic) {
      return false;
    }
    if (queryTokens.length === 0) return true;
    const hay = normalizeSearch(`${note.title || ''} ${note.content || ''} ${note.genre || ''} ${note.topic || ''}`);
    return queryTokens.some(tok => hay.includes(tok));
  });

  const topPlaybooks = (!genre && queryTokens.length > 0 ? playbooks.slice(0, 2) : playbooks)
    .map(({ _relevance, ...clean }) => clean);

  return {
    genre: genre || 'all',
    topic,
    query: query || null,
    playbooks: topPlaybooks,
    learnedNotes: matchedNotes.slice(0, 15),
  };
}

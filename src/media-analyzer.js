import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { extractJsonCandidate } from './json-salvage.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_GEMINI_VISION_MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-3.8-flash';
export const MAX_VIDEO_FRAMES = 6;
export const MAX_FRAME_WIDTH = 800;

/**
 * Executa o ffprobe em um arquivo de mídia e extrai metadados essenciais.
 */
export async function probeMedia(mediaPath, { ffprobePath = 'ffprobe', timeoutMs = 25000 } = {}) {
  try {
    const { stdout } = await execFileAsync(ffprobePath, [
      '-hide_banner',
      '-loglevel', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      mediaPath,
    ], { timeout: timeoutMs });

    const data = JSON.parse(stdout);
    const durationSec = parseFloat(data.format?.duration || 0) || 0;
    const videoStream = data.streams?.find(s => s.codec_type === 'video');
    const audioStream = data.streams?.find(s => s.codec_type === 'audio');

    return {
      durationSec,
      hasVideo: Boolean(videoStream),
      hasAudio: Boolean(audioStream),
      width: videoStream?.width || null,
      height: videoStream?.height || null,
    };
  } catch (err) {
    return {
      durationSec: 0,
      hasVideo: false,
      hasAudio: false,
      error: err.message,
    };
  }
}

/**
 * Extrai frames picotados (amostras uniformes) e áudio de um arquivo de vídeo com ffmpeg.
 */
export async function extractVideoFramesAndAudio({
  videoPath,
  outputDir,
  maxFrames = MAX_VIDEO_FRAMES,
  ffmpegPath = 'ffmpeg',
  ffprobePath = 'ffprobe',
  timeoutMs = 60000,
} = {}) {
  const probe = await probeMedia(videoPath, { ffprobePath });
  const duration = probe.durationSec || 1;
  const frames = [];

  // Calcula tempos de corte proporcionais ao longo do vídeo
  const timestamps = [];
  if (maxFrames <= 1 || duration <= 1) {
    timestamps.push(0);
  } else {
    const step = duration / (maxFrames + 1);
    for (let i = 1; i <= maxFrames; i++) {
      timestamps.push(Math.min(duration - 0.2, Math.max(0, i * step)));
    }
  }

  // 1. Extração de frames picotados para OCR e análise visual
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    const framePath = path.join(outputDir, `frame_${i}.jpg`);
    try {
      await execFileAsync(ffmpegPath, [
        '-hide_banner',
        '-loglevel', 'error',
        '-ss', ts.toFixed(2),
        '-i', videoPath,
        '-vframes', '1',
        '-vf', `scale='min(${MAX_FRAME_WIDTH},iw)':-2`,
        '-q:v', '3',
        '-y',
        framePath,
      ], { timeout: 15000 });

      if (existsSync(framePath)) {
        const frameBuf = await fs.readFile(framePath);
        frames.push({
          index: i,
          timestampSec: Math.round(ts * 10) / 10,
          path: framePath,
          base64: frameBuf.toString('base64'),
          mimeType: 'image/jpeg',
        });
      }
    } catch {
      // Ignora falha de frame isolado
    }
  }

  // 2. Extração do áudio (se houver stream de áudio)
  let audio = null;
  if (probe.hasAudio) {
    const audioPath = path.join(outputDir, 'audio.mp3');
    try {
      await execFileAsync(ffmpegPath, [
        '-hide_banner',
        '-loglevel', 'error',
        '-i', videoPath,
        '-vn',
        '-ac', '1',
        '-ar', '16000',
        '-b:a', '64k',
        '-y',
        audioPath,
      ], { timeout: 30000 });

      if (existsSync(audioPath)) {
        const audioBuf = await fs.readFile(audioPath);
        audio = {
          path: audioPath,
          base64: audioBuf.toString('base64'),
          mimeType: 'audio/mp3',
        };
      }
    } catch {
      audio = null;
    }
  }

  return {
    probe,
    frames,
    audio,
  };
}

/**
 * Analisa mídia (imagem ou vídeo) cruzando OCR e áudio com a inteligência multimodal do Gemini.
 */
export async function analyzeMedia({
  mimeType,
  dataBase64,
  filename = 'media',
  userPrompt = '',
  personaSystemPrompt = '',
  apiKey,
  geminiUrl = 'https://generativelanguage.googleapis.com',
  model = DEFAULT_GEMINI_VISION_MODEL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 90000,
} = {}) {
  if (!apiKey) {
    return {
      ok: false,
      reply: 'Eu queria muito ver o que você mandou, mas a chave de visão (Gemini API) não tá configurada no servidor!',
      gesture: 'scratchHead',
      actions: [{ type: 'gesture', name: 'scratchHead' }],
      error: 'GEMINI_API_KEY ausente',
    };
  }

  const isVideo = mimeType?.startsWith('video/') || /\.(mp4|webm|mkv|mov|avi)$/i.test(filename);
  let parts = [];
  let tempDir = null;

  try {
    if (isVideo) {
      // Processamento de vídeo: picota frames e extrai áudio
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'usami-media-'));
      const videoPath = path.join(tempDir, filename || 'input_video.mp4');
      const videoBuffer = Buffer.from(dataBase64, 'base64');
      await fs.writeFile(videoPath, videoBuffer);

      const extracted = await extractVideoFramesAndAudio({
        videoPath,
        outputDir: tempDir,
        maxFrames: MAX_VIDEO_FRAMES,
      });

      // Inclui faixa de áudio se presente
      if (extracted.audio?.base64) {
        parts.push({
          inlineData: {
            mimeType: extracted.audio.mimeType,
            data: extracted.audio.base64,
          },
        });
      }

      // Inclui frames picotados com timestamps
      for (const f of extracted.frames) {
        parts.push({
          text: `[Frame ${f.index + 1} em ${f.timestampSec}s]:`,
        });
        parts.push({
          inlineData: {
            mimeType: f.mimeType,
            data: f.base64,
          },
        });
      }

      const promptInstruction = `
${personaSystemPrompt ? `=== SUA IDENTIDADE E HISTÓRICO ===\n${personaSystemPrompt}\n\n` : ''}Você é a Usami (companion virtual tsundere fofa, orgulhosa e expressiva).
O usuário acabou de compartilhar com você um VÍDEO intitulado "${filename}".
Mensagem do usuário sobre o vídeo: "${userPrompt || 'Dá uma olhada nisso aqui!'}".

SUAS TAREFAS MULTIMODAIS:
1. OCR DE FRAMES: Examine meticulosamente todos os frames em busca de textos na tela (títulos, legendas, código, slides, memes, placas, interfaces). Identifique cada texto relevante.
2. RECONHECIMENTO DE ÁUDIO: Ouça a faixa de áudio, transcreva as falas e identifique o tom/efeitos sonoros.
3. CRUZAMENTO ÁUDIO + VISUAL: Relacione o que está sendo dito no áudio com o que aparece na tela nos mesmos instantes (ex: o que o locutor aponta, o que acontece no vídeo enquanto ele fala).
4. RESPOSTA DA USAMI: Responda em português como Usami reagindo ao vídeo de forma viva, curiosa e tsundere (comente o que você viu na tela e o que você ouviu no áudio).

FORMATO OBRIGATÓRIO (JSON PURO):
{
  "reply": "sua fala como Usami comentando o que viu na tela e ouviu no áudio (1 a 3 frases naturais, máx 250 caracteres, sem asteriscos ou emojis)",
  "gesture": "surprised"|"thinking"|"blush"|"angry"|"nod"|"clap"|"jump"|"wave"|"scratchHead",
  "actions": [
    {"type": "set_expression", "name": "01-prefab_happy01", "weight": 1},
    {"type": "gesture", "name": "..."}
  ],
  "ocr": ["textos detectados nos frames"],
  "transcript": "transcrição sucinta do áudio",
  "crossReference": "resumo de 1 linha cruzando o áudio e a cena"
}`;

      parts.push({ text: promptInstruction });
    } else {
      // Processamento de imagem única (OCR e visual)
      parts.push({
        inlineData: {
          mimeType: mimeType || 'image/jpeg',
          data: dataBase64,
        },
      });

      const promptInstruction = `
${personaSystemPrompt ? `=== SUA IDENTIDADE E HISTÓRICO ===\n${personaSystemPrompt}\n\n` : ''}Você é a Usami (companion virtual tsundere fofa, orgulhosa e expressiva).
O usuário compartilhou uma IMAGEM com você ("${filename}").
Comentário do usuário: "${userPrompt || 'Olha isso aqui!'}".

SUAS TAREFAS:
1. OCR COMPLETO: Extraia com precisão todo e qualquer texto visível na imagem (memes, prints, mensagens, documentos, placas, roupas).
2. ANÁLISE VISUAL: Entenda o que está acontecendo na cena, objetos, expressões, cores e contexto.
3. RESPOSTA DA USAMI: Reaja em primeira pessoa como Usami de forma autêntica, tsundere e conectada com o que está escrito e visível na imagem.

FORMATO OBRIGATÓRIO (JSON PURO):
{
  "reply": "sua fala como Usami reagindo ao conteúdo da imagem e ao que leu nela (1 a 3 frases naturais, máx 220 caracteres, sem asteriscos ou emojis)",
  "gesture": "surprised"|"thinking"|"blush"|"angry"|"nod"|"clap"|"jump"|"wave"|"scratchHead",
  "actions": [
    {"type": "set_expression", "name": "01-prefab_happy01", "weight": 1},
    {"type": "gesture", "name": "..."}
  ],
  "ocr": ["textos encontrados na imagem"],
  "summary": "descrição concisa da imagem"
}`;

      parts.push({ text: promptInstruction });
    }

    const apiUrl = `${geminiUrl.replace(/\/+$/, '')}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 8192,
          responseMimeType: 'application/json',
        },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text();
      return {
        ok: false,
        reply: 'Hmph! Ocorreu um erro ao tentar processar essa mídia... me mostra de novo depois?',
        gesture: 'scratchHead',
        actions: [{ type: 'gesture', name: 'scratchHead' }],
        error: `Gemini HTTP ${res.status}: ${errText.slice(0, 300)}`,
      };
    }

    const resultJson = await res.json();
    const candidateParts = resultJson.candidates?.[0]?.content?.parts || [];
    const nonThoughtParts = candidateParts.filter(p => !p.thought);
    const candidateText = (nonThoughtParts.length ? nonThoughtParts : candidateParts)
      .map(p => p.text)
      .filter(Boolean)
      .join('\n');

    let parsedObj = {};
    if (candidateText) {
      const fenced = candidateText.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
      try {
        parsedObj = JSON.parse(fenced);
      } catch {
        const candidate = extractJsonCandidate(fenced);
        if (candidate) {
          try {
            parsedObj = JSON.parse(candidate);
          } catch {}
        }
      }

      if (!parsedObj || typeof parsedObj !== 'object' || !parsedObj.reply) {
        parsedObj = parsedObj && typeof parsedObj === 'object' ? parsedObj : {};
        const replyMatch = candidateText.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)/);
        if (replyMatch) {
          parsedObj.reply = replyMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/"\s*,\s*$/, '').trim();
        } else {
          const cleanText = candidateText.replace(/^[\s{"]*reply[\s":]*/i, '').replace(/[}"]*$/, '').trim();
          if (cleanText) {
            parsedObj.reply = cleanText.slice(0, 300);
          }
        }
        const gestureMatch = candidateText.match(/"gesture"\s*:\s*"([a-zA-Z]+)"/);
        if (gestureMatch) parsedObj.gesture = gestureMatch[1];
      }
    }

    return {
      ok: true,
      reply: parsedObj.reply || 'Vi o que você mandou!',
      gesture: parsedObj.gesture || 'nod',
      actions: Array.isArray(parsedObj.actions) ? parsedObj.actions : [],
      ocr: Array.isArray(parsedObj.ocr) ? parsedObj.ocr : [],
      transcript: parsedObj.transcript || null,
      crossReference: parsedObj.crossReference || parsedObj.summary || null,
    };
  } catch (err) {
    return {
      ok: false,
      reply: 'Ai, deu algum problema na leitura da mídia! Pera aí...',
      gesture: 'scratchHead',
      actions: [{ type: 'gesture', name: 'scratchHead' }],
      error: err.message,
    };
  } finally {
    if (tempDir) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

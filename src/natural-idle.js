/**
 * Motor de presença corporal orgânica (estilo Neuro-sama / VTubers).
 *
 * Transforma o avatar de um "boneco rígido" em uma entidade viva:
 * 1. Respiração corporal completa:
 *    - Tórax (chest) expande e retrai
 *    - Ombros (shoulders) sobem e descem suavemente com a respiração
 *    - Pescoço (neck) acompanha o ritmo com micro-oscilação
 * 2. Balanço de centro de gravidade (Weight Shift / Fidgeting):
 *    - Deslocamento sutil de peso entre o quadril (hips) e a coluna (spine)
 *      em ciclo lento (10-14s), eliminando a rigidez estátua.
 * 3. Speech-Reactive Head Bobbing:
 *    - Quando a Usami fala (speechLevel > 0), a cabeça e o pescoço
 *      pontuam as sílabas com micro-inclinações naturais no ritmo da voz.
 *
 * Módulo puro, sem acoplamento direto com Three.js ou DOM.
 */

const TAU = Math.PI * 2;

export function createNaturalIdle({
  now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()),
  breathHz = 0.25,        // 1 ciclo respiratório a cada 4 segundos
  weightShiftHz = 0.08,   // 1 ciclo de troca de peso a cada ~12.5 segundos
  breathAmp = 1,
  weightShiftAmp = 1,
} = {}) {
  const t0 = now();
  const breathPhaseSpeed = (TAU * breathHz) / 1000;
  const weightPhaseSpeed = (TAU * weightShiftHz) / 1000;

  let speechSpeechAccumulator = 0;

  return {
    /**
     * Calcula as rotações e translações relativas para o frame atual.
     *
     * @param {number} [t] Timestamp atual
     * @param {Object} [opts]
     * @param {number} [opts.speechLevel] Volume da fala 0..1 (do AnalyserNode)
     * @param {number} [opts.deltaSeconds] Delta de tempo em segundos
     * @param {boolean} [opts.isThinking] Se está em estado de reflexão/pensamento
     * @param {boolean} [opts.isListening] Se está atenta ouvindo o usuário
     * @returns {{
     *   chest: { rotX: number },
     *   shoulders: { leftRotZ: number, rightRotZ: number },
     *   neck: { rotX: number, rotZ: number },
     *   hips: { rotZ: number, posX: number },
     *   spine: { rotZ: number },
     *   head: { rotX: number, rotY: number, rotZ: number },
     *   arms: { leftRotZ: number, rightRotZ: number, leftRotX: number, rightRotX: number },
     *   breath: number
     * }}
     */
    update(t = now(), { speechLevel = 0, deltaSeconds = 0.016, isThinking = false, isListening = false, isSleeping = false } = {}) {
      const dtMs = t - t0;
      const dt = Math.min(Math.max(deltaSeconds, 0.001), 0.1);

      // 1. Respiração orgânica (desacelera em sono profundo)
      const currentBreathSpeed = isSleeping ? breathPhaseSpeed * 0.55 : breathPhaseSpeed;
      const breathRaw = Math.sin(currentBreathSpeed * dtMs);
      const breathNorm = ((breathRaw + 1) / 2) * (isSleeping ? breathAmp * 1.2 : breathAmp); // 0..1
      const chestRotX = (breathNorm - 0.5) * (isSleeping ? 0.055 : 0.045);

      // Elevação clavicular / ombros na inspiração
      const shoulderElevation = (breathRaw * (isSleeping ? 0.022 : 0.016) * breathAmp) || 0;

      // 2. Balanço lento de peso (Weight-shifting, cessa em repouso de sono)
      const weightCycle = isSleeping ? 0 : Math.sin(weightPhaseSpeed * dtMs) * weightShiftAmp;
      const hipsRotZ = (weightCycle * 0.018) || 0;        // inclina quadril
      const hipsPosX = (weightCycle * 0.012) || 0;        // desloca centro de massa
      const spineCounterRotZ = (-weightCycle * 0.012) || 0; // coluna equilibra

      // 3. Speech-reactive head bobbing
      let speechHeadPitch = 0;
      let speechHeadYaw = 0;
      let speechHeadTilt = 0;

      if (!isSleeping && speechLevel > 0.04) {
        speechSpeechAccumulator += dt * 11; // ~1.75 Hz de ritmo de fala
        const speechOsc = Math.sin(speechSpeechAccumulator);
        const intensity = Math.min(speechLevel, 1);

        speechHeadPitch = speechOsc * 0.038 * intensity;
        speechHeadYaw = Math.cos(speechSpeechAccumulator * 0.6) * 0.018 * intensity;
        speechHeadTilt = Math.sin(speechSpeechAccumulator * 0.4) * 0.014 * intensity;
      } else {
        speechSpeechAccumulator = 0;
      }

      // 4. Modulação ao pensar (head tilt suave + desvio lateral)
      const thinkingHeadTilt = (!isSleeping && isThinking) ? 0.06 : 0;
      const thinkingHeadPitch = (!isSleeping && isThinking) ? -0.03 : 0;
      const thinkingHeadYaw = (!isSleeping && isThinking) ? 0.04 : 0;

      // 5. Modulação ao ouvir o usuário (inclinação atenta para a frente e orelha atenta)
      const listeningHeadTilt = (!isSleeping && isListening) ? -0.045 : 0;
      const listeningHeadPitch = (!isSleeping && isListening) ? -0.025 : 0;
      const listeningChest = (!isSleeping && isListening) ? -0.02 : 0;

      // 6. Modulação ao dormir (cabeça descansa suavemente para a frente e de lado)
      const sleepHeadPitch = isSleeping ? 0.16 : 0;
      const sleepHeadTilt = isSleeping ? 0.10 : 0;
      const sleepNeckPitch = isSleeping ? 0.08 : 0;
      const sleepNeckTilt = isSleeping ? 0.06 : 0;

      // 7. Micro-balanço orgânico dos braços em repouso
      const armBreathSway = shoulderElevation * 0.45;
      const armWeightSway = weightCycle * 0.010;
      const armPitchSway = Math.cos(weightPhaseSpeed * dtMs) * 0.008;

      const leftArmRotZ = -armBreathSway + armWeightSway;
      const rightArmRotZ = armBreathSway + armWeightSway;
      const leftArmRotX = (chestRotX * 0.25) + armPitchSway;
      const rightArmRotX = (chestRotX * 0.25) - armPitchSway;

      return {
        chest: {
          rotX: chestRotX + listeningChest,
        },
        shoulders: {
          leftRotZ: shoulderElevation,
          rightRotZ: (-shoulderElevation) || 0,
        },
        neck: {
          rotX: (breathRaw * 0.008) + (speechHeadPitch * 0.35) + (thinkingHeadPitch * 0.5) + (listeningHeadPitch * 0.4) + sleepNeckPitch,
          rotZ: (weightCycle * 0.006) + (thinkingHeadTilt * 0.4) + (listeningHeadTilt * 0.4) + sleepNeckTilt,
        },
        hips: {
          rotZ: hipsRotZ,
          posX: hipsPosX,
        },
        spine: {
          rotZ: spineCounterRotZ,
        },
        head: {
          rotX: speechHeadPitch + thinkingHeadPitch + listeningHeadPitch + sleepHeadPitch,
          rotY: speechHeadYaw + thinkingHeadYaw,
          rotZ: speechHeadTilt + thinkingHeadTilt + listeningHeadTilt + sleepHeadTilt,
        },
        arms: {
          leftRotZ: leftArmRotZ,
          rightRotZ: rightArmRotZ,
          leftRotX: leftArmRotX,
          rightRotX: rightArmRotX,
        },
        breath: breathNorm,
        isSleeping: Boolean(isSleeping),
      };
    },
  };
}

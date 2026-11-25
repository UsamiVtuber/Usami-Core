import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const SOURCE_DEVICE_SCRIPT = join(REPO_ROOT, 'tools', 'fl-studio', 'device_usami.py');
const SOURCE_PIANOROLL_SCRIPT = join(REPO_ROOT, 'tools', 'fl-studio', 'UsamiImportScore.pyscript');
const DEFAULT_SCORE_JSON_PATH = join(REPO_ROOT, 'data', 'midi', 'latest_score.json').replace(/\\/g, '/');

export function resolveFlSettingsCandidates(userHome = homedir()) {
  return [
    join(userHome, 'Documents', 'Image-Line', 'FL Studio', 'Settings'),
    join(userHome, 'OneDrive', 'Documentos', 'Image-Line', 'FL Studio', 'Settings'),
    join(userHome, 'OneDrive', 'Documents', 'Image-Line', 'FL Studio', 'Settings'),
  ];
}

export function resolveFlHardwareCandidates(userHome = homedir()) {
  return resolveFlSettingsCandidates(userHome).map(dir => join(dir, 'Hardware'));
}

export function installFlScript({ destRoot = null, dryRun = false, userHome = homedir(), scoreJsonPath = DEFAULT_SCORE_JSON_PATH } = {}) {
  if (!existsSync(SOURCE_DEVICE_SCRIPT)) {
    throw new Error(`Script fonte nao encontrado: ${SOURCE_DEVICE_SCRIPT}`);
  }

  let hardwareDir = destRoot ? resolve(destRoot) : null;
  let pianoRollDir = null;

  if (!hardwareDir) {
    const settingsDir = resolveFlSettingsCandidates(userHome).find(candidate => existsSync(join(candidate, 'Hardware'))) || null;
    if (settingsDir) {
      hardwareDir = join(settingsDir, 'Hardware');
      pianoRollDir = join(settingsDir, 'Piano roll scripts');
    }
  } else {
    pianoRollDir = join(resolve(hardwareDir, '..'), 'Piano roll scripts');
  }

  if (!hardwareDir) {
    throw new Error('Pasta Settings\\Hardware do FL Studio nao encontrada. Informe --dest <caminho>.');
  }

  const targetDir = join(hardwareDir, 'Usami');
  const targetFile = join(targetDir, 'device_usami.py');
  const pianoRollTargetFile = pianoRollDir ? join(pianoRollDir, 'UsamiImportScore.pyscript') : null;

  if (!dryRun) {
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(targetFile, readFileSync(SOURCE_DEVICE_SCRIPT));

    if (pianoRollTargetFile && existsSync(SOURCE_PIANOROLL_SCRIPT)) {
      mkdirSync(pianoRollDir, { recursive: true });
      const tpl = readFileSync(SOURCE_PIANOROLL_SCRIPT, 'utf8')
        .replace('__USAMI_LATEST_SCORE_JSON__', scoreJsonPath.replace(/\\/g, '/'));
      writeFileSync(pianoRollTargetFile, tpl, 'utf8');
    }
  }

  return {
    ok: true,
    dryRun,
    source: SOURCE_DEVICE_SCRIPT,
    hardwareDir,
    targetFile,
    pianoRollScript: pianoRollTargetFile,
  };
}

function parseCliArgs(argv) {
  let dest = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--dest' && argv[i + 1]) {
      dest = argv[i + 1];
      i += 1;
    }
  }
  return { dest, dryRun };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const { dest, dryRun } = parseCliArgs(process.argv.slice(2));
    const result = installFlScript({ destRoot: dest, dryRun });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error?.message || String(error));
    process.exit(1);
  }
}

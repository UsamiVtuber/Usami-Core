/**
 * Helper compartilhado para publicação idempotente de pacotes de skills
 * versionados em `skills/<id>/` para `dataDir/skills/<id>/`.
 *
 * Só copia quando `skill.json` ainda não existe no destino (preservando
 * alterações de estado feitas pelo operador, como `disabled` ou `pending`).
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');

function copyPlainDirectory(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    const stat = lstatSync(srcPath);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      copyPlainDirectory(srcPath, destPath);
    } else if (stat.isFile()) {
      writeFileSync(destPath, readFileSync(srcPath));
    }
  }
}

export function publishSkillPackage({
  skillId,
  dataDir,
  bundledDir = join(SKILLS_ROOT, skillId),
} = {}) {
  if (!skillId || typeof skillId !== 'string') {
    throw new Error('publishSkillPackage: skillId é obrigatório.');
  }
  if (!dataDir || typeof dataDir !== 'string') {
    throw new Error(`publishSkillPackage(${skillId}): dataDir é obrigatório.`);
  }
  const targetDir = join(dataDir, 'skills', skillId);
  const targetManifest = join(targetDir, 'skill.json');
  if (existsSync(targetManifest)) {
    return { published: false, alreadyPresent: true, skillDir: targetDir };
  }
  if (!existsSync(join(bundledDir, 'skill.json'))) {
    throw new Error(`publishSkillPackage(${skillId}): pacote base ausente em ${bundledDir}`);
  }
  copyPlainDirectory(bundledDir, targetDir);
  return { published: true, alreadyPresent: false, skillDir: targetDir };
}


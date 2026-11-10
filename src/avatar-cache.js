import { createHash } from 'node:crypto';
import { stat, readFile, open } from 'node:fs/promises';
import { resolve, normalize, sep, extname } from 'node:path';

const DIGEST_CACHE = new Map();
const MAX_DIGEST_CACHE_ENTRIES = 2048;

const MIME_TYPES = Object.freeze({
  '.vrm': 'model/gltf-binary',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.vrma': 'model/gltf-binary',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.moc3': 'application/octet-stream',
  '.model3.json': 'application/json',
  '.motion3.json': 'application/json',
  '.exp3.json': 'application/json',
});

function getMimeType(filePath) {
  const lower = filePath.toLowerCase();
  for (const [ext, mime] of Object.entries(MIME_TYPES)) {
    if (lower.endsWith(ext)) return mime;
  }
  return 'application/octet-stream';
}

function getStatIdentity(fileStat) {
  return `${fileStat.mtimeMs}_${fileStat.ctimeMs}_${fileStat.size}_${fileStat.ino || 0}`;
}

async function getDigestForFile(filePath, fileStat) {
  const identity = getStatIdentity(fileStat);
  const cached = DIGEST_CACHE.get(filePath);
  if (cached && cached.identity === identity) {
    return cached.digest;
  }

  const hash = createHash('sha256');
  const fileHandle = await open(filePath, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let bytesRead;
    do {
      const result = await fileHandle.read(buffer, 0, buffer.length, null);
      bytesRead = result.bytesRead;
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
  } finally {
    await fileHandle.close();
  }

  const freshStat = await stat(filePath);
  if (getStatIdentity(freshStat) !== identity) {
    throw new Error('Arquivo alterado durante a geração do hash.');
  }

  const digest = hash.digest('hex');
  if (DIGEST_CACHE.size >= MAX_DIGEST_CACHE_ENTRIES) {
    const firstKey = DIGEST_CACHE.keys().next().value;
    DIGEST_CACHE.delete(firstKey);
  }
  DIGEST_CACHE.set(filePath, { identity, digest });
  return digest;
}

export function isNotModified(reqHeaders = {}, etag, lastModified) {
  const ifNoneMatch = reqHeaders['if-none-match'];
  if (typeof ifNoneMatch === 'string' && ifNoneMatch.trim()) {
    const tags = ifNoneMatch.split(',').map(t => t.trim().replace(/^W\//, '').replace(/^"|"$/g, ''));
    const cleanEtag = String(etag || '').replace(/^W\//, '').replace(/^"|"$/g, '');
    return tags.includes('*') || tags.includes(cleanEtag);
  }

  const ifModifiedSince = reqHeaders['if-modified-since'];
  if (typeof ifModifiedSince === 'string' && ifModifiedSince.trim() && lastModified) {
    const sinceTime = Date.parse(ifModifiedSince);
    const modTime = Date.parse(lastModified);
    if (!Number.isNaN(sinceTime) && !Number.isNaN(modTime)) {
      return sinceTime >= modTime;
    }
  }

  return false;
}

export function createStaticAssetHandler({ rootDir } = {}) {
  const root = resolve(rootDir || process.cwd());

  return async function handleStaticAsset(req, res, customSubPath = null) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return false;
    }

    let pathname = customSubPath;
    if (!pathname) {
      try {
        const urlObj = new URL(req.url, 'http://127.0.0.1');
        pathname = decodeURIComponent(urlObj.pathname);
      } catch {
        return false;
      }
    }

    const normalizedRel = normalize(pathname).replace(/^[/\\]+/, '');
    const fullPath = resolve(root, normalizedRel);

    // Proteção contra path traversal
    if (!fullPath.startsWith(root + sep) && fullPath !== root) {
      return false;
    }

    let fileStat;
    try {
      fileStat = await stat(fullPath);
      if (!fileStat.isFile()) return false;
    } catch {
      return false;
    }

    try {
      const digest = await getDigestForFile(fullPath, fileStat);
      const etag = `"${digest}"`;
      const lastModified = fileStat.mtime.toUTCString();
      const mimeType = getMimeType(fullPath);

      const urlObj = new URL(req.url, 'http://127.0.0.1');
      const hasVersionParam = urlObj.searchParams.has('v');
      const cacheControl = (hasVersionParam && urlObj.searchParams.get('v') === digest)
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=0, must-revalidate';

      if (isNotModified(req.headers, etag, lastModified)) {
        res.writeHead(304, {
          'ETag': etag,
          'Last-Modified': lastModified,
          'Cache-Control': cacheControl,
          'X-Content-Type-Options': 'nosniff',
        });
        res.end();
        return true;
      }

      res.writeHead(200, {
        'Content-Type': mimeType,
        'Content-Length': fileStat.size,
        'ETag': etag,
        'Last-Modified': lastModified,
        'Cache-Control': cacheControl,
        'X-Content-Type-Options': 'nosniff',
      });

      if (req.method === 'HEAD') {
        res.end();
        return true;
      }

      const content = await readFile(fullPath);
      res.end(content);
      return true;
    } catch (err) {
      console.warn('[avatar-cache] falha ao servir asset:', err?.message || err);
      return false;
    }
  };
}


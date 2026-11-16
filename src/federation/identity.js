/**
 * Identidade Federada Ed25519 (`did:key`) e Envelopes Assinados (Fase 4 — RFC-001).
 *
 * Usa exclusivamente `node:crypto` nativo (sem dependências externas) para
 * gerar pares Ed25519, derivar identificadores `did:key` e assinar/verificar
 * mensagens entre instâncias federadas de AI VTubers.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';

export const FEDERATION_ENVELOPE_SCHEMA = 'usami.federation.envelope.v1';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes) {
  if (!bytes || bytes.length === 0) return '';
  let num = BigInt('0x' + Buffer.from(bytes).toString('hex'));
  let out = '';
  while (num > 0n) {
    const rem = Number(num % 58n);
    out = BASE58_ALPHABET[rem] + out;
    num /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) out = '1' + out;
    else break;
  }
  return out;
}

/**
 * Gera um par de chaves Ed25519 e deriva seu `did:key:z...` (prefixo multicodec 0xed01).
 */
export function generateAgentIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const rawPub = spki.subarray(spki.length - 32);
  const multicodec = Buffer.concat([Buffer.from([0xed, 0x01]), rawPub]);
  const did = `did:key:z${base58Encode(multicodec)}`;

  return {
    did,
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }),
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
  };
}

function canonicalPayload(envelope) {
  return JSON.stringify({
    schema: envelope.schema,
    did: envelope.did,
    timestamp: envelope.timestamp,
    nonce: envelope.nonce,
    payload: envelope.payload,
  });
}

export function signFederatedEnvelope({
  did,
  privateKeyPem,
  publicKeyPem,
  payload,
  now = () => Date.now(),
} = {}) {
  if (!did || !privateKeyPem || !publicKeyPem) {
    throw new Error('did, privateKeyPem e publicKeyPem são obrigatórios.');
  }
  const envelope = {
    schema: FEDERATION_ENVELOPE_SCHEMA,
    did,
    publicKeyPem,
    timestamp: now(),
    nonce: randomBytes(12).toString('hex'),
    payload: payload ?? {},
  };
  const keyObj = createPrivateKey(privateKeyPem);
  const sig = sign(null, Buffer.from(canonicalPayload(envelope), 'utf8'), keyObj);
  return {
    ...envelope,
    signature: sig.toString('base64'),
  };
}

export function verifyFederatedEnvelope(
  envelope,
  { seenNonces = null, maxSkewMs = 300_000, now = () => Date.now() } = {},
) {
  if (!envelope || typeof envelope !== 'object') {
    return { ok: false, reason: 'Envelope inválido.' };
  }
  if (envelope.schema !== FEDERATION_ENVELOPE_SCHEMA) {
    return { ok: false, reason: 'Schema de federação inválido.' };
  }
  if (typeof envelope.did !== 'string' || !envelope.did.startsWith('did:key:z')) {
    return { ok: false, reason: 'DID inválido.' };
  }
  if (typeof envelope.timestamp !== 'number' || Math.abs(now() - envelope.timestamp) > maxSkewMs) {
    return { ok: false, reason: 'Timestamp expirado ou fora da janela permitida.' };
  }
  if (typeof envelope.nonce !== 'string' || envelope.nonce.length < 8) {
    return { ok: false, reason: 'Nonce inválido.' };
  }
  if (seenNonces && seenNonces.has(envelope.nonce)) {
    return { ok: false, reason: 'Replay detectado (nonce repetido).' };
  }
  try {
    const pub = createPublicKey(envelope.publicKeyPem);
    const sigBuf = Buffer.from(String(envelope.signature || ''), 'base64');
    const valid = verify(null, Buffer.from(canonicalPayload(envelope), 'utf8'), pub, sigBuf);
    if (!valid) {
      return { ok: false, reason: 'Assinatura Ed25519 inválida.' };
    }
    if (seenNonces) seenNonces.add(envelope.nonce);
    return { ok: true, did: envelope.did };
  } catch {
    return { ok: false, reason: 'Falha ao verificar chave pública/assinatura.' };
  }
}

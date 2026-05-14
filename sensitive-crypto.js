import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const SENSITIVE_CRYPTO_ENV_VAR = "PSICOTAREFAS_SENSITIVE_DATA_KEY";
export const SENSITIVE_CRYPTO_ALGORITHM = "AES-256-GCM";
export const SENSITIVE_CRYPTO_VERSION = 1;

export const TASK_SENSITIVE_FIELDS = Object.freeze(["titulo", "descricao"]);
export const INTERACTION_SENSITIVE_FIELDS = Object.freeze(["mensagem"]);
export const SESSION_SUMMARY_SENSITIVE_FIELDS = Object.freeze([
  "texto_transcrito",
  "resumo_final"
]);

const IV_LENGTH_BYTES = 12;
const KEY_LENGTH_BYTES = 32;

export class SensitiveCryptoError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.name = "SensitiveCryptoError";
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function getConfiguredKeyText() {
  return String(process.env[SENSITIVE_CRYPTO_ENV_VAR] || "").trim();
}

function decodeBase64Key(value) {
  const normalized = value.trim();
  const key = Buffer.from(normalized, "base64");
  const roundTrip = key.toString("base64").replace(/=+$/u, "");
  const expected = normalized.replace(/=+$/u, "");

  if (roundTrip !== expected) {
    throw new SensitiveCryptoError(
      `A variável ${SENSITIVE_CRYPTO_ENV_VAR} não contém uma chave base64 válida.`,
      "SENSITIVE_KEY_INVALID"
    );
  }

  return key;
}

function decodeHexKey(value) {
  const normalized = value.trim();

  if (!/^[0-9a-f]{64}$/iu.test(normalized)) {
    throw new SensitiveCryptoError(
      `A variável ${SENSITIVE_CRYPTO_ENV_VAR} não contém uma chave hexadecimal válida.`,
      "SENSITIVE_KEY_INVALID"
    );
  }

  return Buffer.from(normalized, "hex");
}

export function getSensitiveCryptoKey() {
  const configuredKey = getConfiguredKeyText();

  if (!configuredKey) {
    throw new SensitiveCryptoError(
      `Configure ${SENSITIVE_CRYPTO_ENV_VAR} no backend antes de gravar ou ler dados sensíveis criptografados.`,
      "SENSITIVE_KEY_MISSING"
    );
  }

  const key = configuredKey.startsWith("base64:")
    ? decodeBase64Key(configuredKey.slice("base64:".length))
    : configuredKey.startsWith("hex:")
      ? decodeHexKey(configuredKey.slice("hex:".length))
      : /^[0-9a-f]{64}$/iu.test(configuredKey)
        ? decodeHexKey(configuredKey)
        : decodeBase64Key(configuredKey);

  if (key.length !== KEY_LENGTH_BYTES) {
    throw new SensitiveCryptoError(
      `A variável ${SENSITIVE_CRYPTO_ENV_VAR} precisa ter exatamente 32 bytes após a decodificação.`,
      "SENSITIVE_KEY_INVALID_LENGTH"
    );
  }

  return key;
}

export function isSensitiveCryptoConfigured() {
  try {
    getSensitiveCryptoKey();
    return true;
  } catch {
    return false;
  }
}

export function assertSensitiveCryptoConfigured() {
  getSensitiveCryptoKey();
}

function normalizeSensitiveText(value) {
  if (value === null || value === undefined) return value;
  return String(value);
}

function parseSensitiveEnvelope(value) {
  const envelope = typeof value === "string" ? parseJsonEnvelope(value) : value;

  if (!envelope || typeof envelope !== "object") return null;

  const isValidEnvelope =
    envelope.v === SENSITIVE_CRYPTO_VERSION &&
    envelope.alg === SENSITIVE_CRYPTO_ALGORITHM &&
    typeof envelope.iv === "string" &&
    typeof envelope.tag === "string" &&
    typeof envelope.data === "string";

  return isValidEnvelope ? envelope : null;
}

function parseJsonEnvelope(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function isEncryptedSensitiveValue(value) {
  return Boolean(parseSensitiveEnvelope(value));
}

export function encryptSensitive(value) {
  const text = normalizeSensitiveText(value);

  if (text === null || text === undefined || text === "") return text;
  if (isEncryptedSensitiveValue(text)) return text;

  const key = getSensitiveCryptoKey();
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return JSON.stringify({
    v: SENSITIVE_CRYPTO_VERSION,
    alg: SENSITIVE_CRYPTO_ALGORITHM,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64")
  });
}

export function decryptSensitive(value) {
  if (value === null || value === undefined || value === "") return value;

  const envelope = parseSensitiveEnvelope(value);

  if (!envelope) {
    return normalizeSensitiveText(value);
  }

  const key = getSensitiveCryptoKey();

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(envelope.iv, "base64")
    );

    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));

    return Buffer.concat([
      decipher.update(Buffer.from(envelope.data, "base64")),
      decipher.final()
    ]).toString("utf8");
  } catch (error) {
    throw new SensitiveCryptoError(
      "Não foi possível descriptografar o dado sensível. Verifique a chave configurada no backend.",
      "SENSITIVE_DECRYPT_FAILED",
      error
    );
  }
}

export function encryptSensitiveFields(record, fields) {
  return transformSensitiveFields(record, fields, encryptSensitive);
}

export function decryptSensitiveFields(record, fields) {
  return transformSensitiveFields(record, fields, decryptSensitive);
}

export function encryptSensitiveRows(rows, fields) {
  return Array.isArray(rows) ? rows.map((row) => encryptSensitiveFields(row, fields)) : [];
}

export function decryptSensitiveRows(rows, fields) {
  return Array.isArray(rows) ? rows.map((row) => decryptSensitiveFields(row, fields)) : [];
}

function transformSensitiveFields(record, fields, transform) {
  if (!record || typeof record !== "object") return record;

  const transformed = { ...record };

  fields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(transformed, field)) {
      transformed[field] = transform(transformed[field]);
    }
  });

  return transformed;
}

export function encryptTaskSensitiveFields(task) {
  return encryptSensitiveFields(task, TASK_SENSITIVE_FIELDS);
}

export function decryptTaskSensitiveFields(task) {
  return decryptSensitiveFields(task, TASK_SENSITIVE_FIELDS);
}

export function encryptTaskSensitiveRows(tasks) {
  return encryptSensitiveRows(tasks, TASK_SENSITIVE_FIELDS);
}

export function decryptTaskSensitiveRows(tasks) {
  return decryptSensitiveRows(tasks, TASK_SENSITIVE_FIELDS);
}

export function encryptInteractionSensitiveFields(interaction) {
  return encryptSensitiveFields(interaction, INTERACTION_SENSITIVE_FIELDS);
}

export function decryptInteractionSensitiveFields(interaction) {
  return decryptSensitiveFields(interaction, INTERACTION_SENSITIVE_FIELDS);
}

export function encryptInteractionSensitiveRows(interactions) {
  return encryptSensitiveRows(interactions, INTERACTION_SENSITIVE_FIELDS);
}

export function decryptInteractionSensitiveRows(interactions) {
  return decryptSensitiveRows(interactions, INTERACTION_SENSITIVE_FIELDS);
}

export function encryptSessionSummarySensitiveFields(summary) {
  return encryptSensitiveFields(summary, SESSION_SUMMARY_SENSITIVE_FIELDS);
}

export function decryptSessionSummarySensitiveFields(summary) {
  return decryptSensitiveFields(summary, SESSION_SUMMARY_SENSITIVE_FIELDS);
}

export function encryptSessionSummarySensitiveRows(summaries) {
  return encryptSensitiveRows(summaries, SESSION_SUMMARY_SENSITIVE_FIELDS);
}

export function decryptSessionSummarySensitiveRows(summaries) {
  return decryptSensitiveRows(summaries, SESSION_SUMMARY_SENSITIVE_FIELDS);
}

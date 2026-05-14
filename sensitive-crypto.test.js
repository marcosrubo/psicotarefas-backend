import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import {
  SENSITIVE_CRYPTO_ENV_VAR,
  SensitiveCryptoError,
  decryptInteractionSensitiveFields,
  decryptSensitive,
  decryptTaskSensitiveFields,
  encryptInteractionSensitiveFields,
  encryptSensitive,
  encryptTaskSensitiveFields,
  isEncryptedSensitiveValue,
  isSensitiveCryptoConfigured
} from "./sensitive-crypto.js";

const originalKey = process.env[SENSITIVE_CRYPTO_ENV_VAR];

function setValidKey() {
  process.env[SENSITIVE_CRYPTO_ENV_VAR] = `base64:${randomBytes(32).toString("base64")}`;
}

test.afterEach(() => {
  if (originalKey === undefined) {
    delete process.env[SENSITIVE_CRYPTO_ENV_VAR];
  } else {
    process.env[SENSITIVE_CRYPTO_ENV_VAR] = originalKey;
  }
});

test("criptografa e descriptografa um texto sensível", () => {
  setValidKey();

  const encrypted = encryptSensitive("Tarefa sobre ansiedade");

  assert.notEqual(encrypted, "Tarefa sobre ansiedade");
  assert.equal(isEncryptedSensitiveValue(encrypted), true);
  assert.equal(decryptSensitive(encrypted), "Tarefa sobre ansiedade");
});

test("gera conteúdos criptografados diferentes para o mesmo texto", () => {
  setValidKey();

  const first = encryptSensitive("Mensagem do paciente");
  const second = encryptSensitive("Mensagem do paciente");

  assert.notEqual(first, second);
  assert.equal(decryptSensitive(first), "Mensagem do paciente");
  assert.equal(decryptSensitive(second), "Mensagem do paciente");
});

test("mantém texto puro legível como fallback temporário", () => {
  delete process.env[SENSITIVE_CRYPTO_ENV_VAR];

  assert.equal(decryptSensitive("texto antigo sem criptografia"), "texto antigo sem criptografia");
  assert.equal(isEncryptedSensitiveValue("texto antigo sem criptografia"), false);
});

test("bloqueia criptografia quando a chave não está configurada", () => {
  delete process.env[SENSITIVE_CRYPTO_ENV_VAR];

  assert.equal(isSensitiveCryptoConfigured(), false);
  assert.throws(
    () => encryptSensitive("dado sensível"),
    (error) =>
      error instanceof SensitiveCryptoError &&
      error.code === "SENSITIVE_KEY_MISSING"
  );
});

test("criptografa e descriptografa campos de tarefas e interações", () => {
  setValidKey();

  const task = encryptTaskSensitiveFields({
    id: 1,
    titulo: "Título clínico",
    descricao: "Descrição clínica",
    status: "aberta"
  });

  assert.equal(isEncryptedSensitiveValue(task.titulo), true);
  assert.equal(isEncryptedSensitiveValue(task.descricao), true);
  assert.equal(task.status, "aberta");

  const decryptedTask = decryptTaskSensitiveFields(task);

  assert.equal(decryptedTask.titulo, "Título clínico");
  assert.equal(decryptedTask.descricao, "Descrição clínica");

  const interaction = encryptInteractionSensitiveFields({
    id: 10,
    mensagem: "Mensagem terapêutica",
    autor_tipo: "paciente"
  });

  assert.equal(isEncryptedSensitiveValue(interaction.mensagem), true);
  assert.equal(decryptInteractionSensitiveFields(interaction).mensagem, "Mensagem terapêutica");
});

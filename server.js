import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import { createClient } from "@supabase/supabase-js";
import {
  SENSITIVE_CRYPTO_ENV_VAR,
  decryptInteractionSensitiveFields,
  decryptInteractionSensitiveRows,
  decryptSessionSummarySensitiveFields,
  decryptSessionSummarySensitiveRows,
  decryptTaskSensitiveFields,
  decryptTaskSensitiveRows,
  encryptInteractionSensitiveFields,
  encryptSessionSummarySensitiveFields,
  encryptTaskSensitiveFields,
  isSensitiveCryptoConfigured
} from "./sensitive-crypto.js";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "25mb" }));

const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const OPENAI_IMAGE_ENDPOINT = "https://api.openai.com/v1/images/generations";
const TASK_PDF_BUCKET = process.env.TASK_PDF_BUCKET || "banco-tarefas-pdf";
const TASK_PDF_PREVIEW_BUCKET = process.env.TASK_PDF_PREVIEW_BUCKET || "banco-tarefas-preview";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "marcos@rubo.com.br";
const PDF_STANDARD_FONTS_URL = new URL("./node_modules/pdfjs-dist/standard_fonts/", import.meta.url).toString();

const supabaseAdmin =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      })
    : null;

if (!isSensitiveCryptoConfigured()) {
  console.warn(
    `[security] ${SENSITIVE_CRYPTO_ENV_VAR} nao configurada. Rotas futuras de dados sensiveis devem bloquear leitura e gravacao criptografada ate a chave existir no backend.`
  );
}

function getBearerToken(req) {
  const authorization = String(req.headers.authorization || "");
  const [type, token] = authorization.split(" ");

  if (!/^bearer$/iu.test(type) || !token) {
    return "";
  }

  return token.trim();
}

async function getAuthenticatedUser(req) {
  if (!supabaseAdmin) {
    throw Object.assign(new Error("Supabase Admin não configurado no backend."), {
      statusCode: 503
    });
  }

  const token = getBearerToken(req);

  if (!token) {
    throw Object.assign(new Error("Sessão não informada."), {
      statusCode: 401
    });
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);

  if (error || !data?.user) {
    throw Object.assign(new Error("Sessão inválida ou expirada."), {
      statusCode: 401
    });
  }

  return data.user;
}

async function getUserProfile(userId) {
  const { data, error } = await supabaseAdmin
    .from("perfis")
    .select("user_id, perfil, nome, email")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function requireProfessionalProfile(userId) {
  const profile = await getUserProfile(userId);

  if (profile?.perfil !== "profissional") {
    throw Object.assign(new Error("Acesso permitido apenas para profissionais."), {
      statusCode: 403
    });
  }

  return profile;
}

function requireAdminUser(user) {
  if (!user?.email || user.email !== ADMIN_EMAIL) {
    throw Object.assign(new Error("Acesso permitido apenas para administradores."), {
      statusCode: 403
    });
  }
}

async function verifyActiveProfessionalLink({ professionalUserId, patientUserId, vinculoId }) {
  let query = supabaseAdmin
    .from("vinculos")
    .select("id, professional_user_id, patient_user_id, status")
    .eq("professional_user_id", professionalUserId)
    .eq("patient_user_id", patientUserId)
    .eq("status", "ativo");

  if (vinculoId !== null && vinculoId !== undefined && String(vinculoId).trim()) {
    query = query.eq("id", vinculoId);
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw Object.assign(new Error("Vínculo ativo não encontrado para criar a tarefa."), {
      statusCode: 403
    });
  }

  return data;
}

function handleApiError(res, error, fallbackMessage = "Erro inesperado.") {
  const statusCode = Number(error?.statusCode) || 500;

  if (statusCode >= 500) {
    console.error(error);
  }

  return res.status(statusCode).json({
    error: error?.message || fallbackMessage
  });
}

function normalizeTaskPayload(payload = {}) {
  const allowedFields = [
    "professional_user_id",
    "patient_user_id",
    "vinculo_id",
    "titulo",
    "descricao",
    "status",
    "interacao_paciente_tipo",
    "interacao_paciente_limite",
    "origem_tipo",
    "origem_banco_tarefa_id",
    "pdf_path",
    "pdf_nome",
    "video_url"
  ];

  return allowedFields.reduce((result, field) => {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      result[field] = payload[field];
    }

    return result;
  }, {});
}

function normalizeInteractionPayload(payload = {}) {
  const allowedFields = ["tarefa_id", "autor_tipo", "autor_user_id", "mensagem"];

  return allowedFields.reduce((result, field) => {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      result[field] = payload[field];
    }

    return result;
  }, {});
}

function normalizeSessionSummaryPayload(payload = {}) {
  const allowedFields = [
    "vinculo_id",
    "professional_user_id",
    "patient_user_id",
    "data_sessao",
    "texto_transcrito",
    "resumo_final",
    "status",
    "origem_transcricao"
  ];

  return allowedFields.reduce((result, field) => {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      result[field] = payload[field];
    }

    return result;
  }, {});
}

function normalizePatientInteractionType(value) {
  if (value === "limitado" || value === "ilimitado") return value;
  return "nao_permitir";
}

function normalizePatientInteractionLimit(type, value) {
  if (type !== "limitado") return null;

  const number = Number.parseInt(String(value || "1"), 10);
  return Number.isFinite(number) && number > 0 ? number : 1;
}

async function getAccessibleTaskForUser(userId, taskId) {
  const { data, error } = await supabaseAdmin
    .from("tarefas")
    .select("*")
    .eq("id", taskId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw Object.assign(new Error("Tarefa não encontrada."), {
      statusCode: 404
    });
  }

  const isProfessionalOwner = data.professional_user_id === userId;
  const isPatientOwner = data.patient_user_id === userId;

  if (!isProfessionalOwner && !isPatientOwner) {
    throw Object.assign(new Error("Você não tem acesso a esta tarefa."), {
      statusCode: 403
    });
  }

  return {
    task: data,
    role: isProfessionalOwner ? "profissional" : "paciente"
  };
}

async function assertPatientCanCreateInteraction(task) {
  if (task.status === "encerrada") {
    throw Object.assign(new Error("Esta tarefa está encerrada e não recebe novas interações."), {
      statusCode: 403
    });
  }

  const type = normalizePatientInteractionType(task.interacao_paciente_tipo);
  const limit = normalizePatientInteractionLimit(type, task.interacao_paciente_limite);

  if (type === "nao_permitir") {
    throw Object.assign(new Error("Esta tarefa não permite novas interações do paciente."), {
      statusCode: 403
    });
  }

  if (type !== "limitado") {
    return;
  }

  const { count, error } = await supabaseAdmin
    .from("tarefa_interacoes")
    .select("id", { count: "exact", head: true })
    .eq("tarefa_id", task.id);

  if (error) {
    throw error;
  }

  if ((count || 0) >= limit) {
    throw Object.assign(new Error(`Esta tarefa já atingiu o limite de ${limit} interação(ões).`), {
      statusCode: 403
    });
  }
}

app.get("/", (req, res) => {
  res.send("API PsicoTarefas rodando 🚀");
});

app.get("/api/tasks/professional", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    await requireProfessionalProfile(user.id);

    let query = supabaseAdmin
      .from("tarefas")
      .select("*")
      .eq("professional_user_id", user.id)
      .order("created_at", { ascending: false });

    const patientUserId = String(req.query.patient_user_id || "").trim();

    if (patientUserId) {
      query = query.eq("patient_user_id", patientUserId);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    return res.json({ tasks: decryptTaskSensitiveRows(data || []) });
  } catch (error) {
    return handleApiError(res, error, "Não foi possível carregar as tarefas.");
  }
});

app.get("/api/tasks/patient", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);

    const { data, error } = await supabaseAdmin
      .from("tarefas")
      .select("*")
      .eq("patient_user_id", user.id)
      .order("created_at", { ascending: false });

    if (error) {
      throw error;
    }

    return res.json({ tasks: decryptTaskSensitiveRows(data || []) });
  } catch (error) {
    return handleApiError(res, error, "Não foi possível carregar as tarefas.");
  }
});

app.get("/api/tasks/:taskId", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    const taskId = String(req.params.taskId || "").trim();

    if (!taskId) {
      return res.status(400).json({ error: "Tarefa não informada." });
    }

    const { data, error } = await supabaseAdmin
      .from("tarefas")
      .select("*")
      .eq("id", taskId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      return res.status(404).json({ error: "Tarefa não encontrada." });
    }

    const isProfessionalOwner = data.professional_user_id === user.id;
    const isPatientOwner = data.patient_user_id === user.id;

    if (!isProfessionalOwner && !isPatientOwner) {
      return res.status(403).json({ error: "Você não tem acesso a esta tarefa." });
    }

    return res.json({ task: decryptTaskSensitiveFields(data) });
  } catch (error) {
    return handleApiError(res, error, "Não foi possível carregar a tarefa.");
  }
});

app.post("/api/tasks", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    await requireProfessionalProfile(user.id);

    const payload = normalizeTaskPayload(req.body || {});
    payload.professional_user_id = user.id;

    const patientUserId = String(payload.patient_user_id || "").trim();
    const titulo = String(payload.titulo || "").trim();

    if (!patientUserId) {
      return res.status(400).json({ error: "Paciente não informado para a tarefa." });
    }

    if (!titulo) {
      return res.status(400).json({ error: "Informe o título da tarefa." });
    }

    const vinculo = await verifyActiveProfessionalLink({
      professionalUserId: user.id,
      patientUserId,
      vinculoId: payload.vinculo_id
    });

    payload.patient_user_id = patientUserId;
    payload.vinculo_id = vinculo.id;
    payload.titulo = titulo;

    if (Object.prototype.hasOwnProperty.call(payload, "descricao")) {
      payload.descricao =
        payload.descricao === null || payload.descricao === undefined
          ? payload.descricao
          : String(payload.descricao).trim();
    }

    const encryptedPayload = encryptTaskSensitiveFields(payload);

    const { data, error } = await supabaseAdmin
      .from("tarefas")
      .insert(encryptedPayload)
      .select()
      .single();

    if (error) {
      throw error;
    }

    return res.status(201).json({ task: decryptTaskSensitiveFields(data) });
  } catch (error) {
    return handleApiError(res, error, "Não foi possível criar a tarefa.");
  }
});

app.patch("/api/tasks/:taskId", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    await requireProfessionalProfile(user.id);

    const taskId = String(req.params.taskId || "").trim();

    if (!taskId) {
      return res.status(400).json({ error: "Tarefa não informada." });
    }

    const { data: currentTask, error: currentTaskError } = await supabaseAdmin
      .from("tarefas")
      .select("id, professional_user_id")
      .eq("id", taskId)
      .maybeSingle();

    if (currentTaskError) {
      throw currentTaskError;
    }

    if (!currentTask) {
      return res.status(404).json({ error: "Tarefa não encontrada." });
    }

    if (currentTask.professional_user_id !== user.id) {
      return res.status(403).json({ error: "Você não pode alterar esta tarefa." });
    }

    const payload = normalizeTaskPayload(req.body || {});
    delete payload.professional_user_id;
    delete payload.patient_user_id;
    delete payload.vinculo_id;
    delete payload.origem_tipo;
    delete payload.origem_banco_tarefa_id;

    if (Object.prototype.hasOwnProperty.call(payload, "titulo")) {
      payload.titulo = String(payload.titulo || "").trim();

      if (!payload.titulo) {
        return res.status(400).json({ error: "Informe o título da tarefa." });
      }
    }

    if (Object.prototype.hasOwnProperty.call(payload, "descricao")) {
      payload.descricao =
        payload.descricao === null || payload.descricao === undefined
          ? payload.descricao
          : String(payload.descricao).trim();
    }

    const encryptedPayload = encryptTaskSensitiveFields(payload);

    const { data, error } = await supabaseAdmin
      .from("tarefas")
      .update(encryptedPayload)
      .eq("id", taskId)
      .select()
      .single();

    if (error) {
      throw error;
    }

    return res.json({ task: decryptTaskSensitiveFields(data) });
  } catch (error) {
    return handleApiError(res, error, "Não foi possível alterar a tarefa.");
  }
});

app.get("/api/tasks/:taskId/interactions", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    const taskId = String(req.params.taskId || "").trim();

    if (!taskId) {
      return res.status(400).json({ error: "Tarefa não informada." });
    }

    await getAccessibleTaskForUser(user.id, taskId);

    const { data, error } = await supabaseAdmin
      .from("tarefa_interacoes")
      .select("*")
      .eq("tarefa_id", taskId)
      .order("created_at", { ascending: true });

    if (error) {
      throw error;
    }

    return res.json({ interactions: decryptInteractionSensitiveRows(data || []) });
  } catch (error) {
    return handleApiError(res, error, "Não foi possível carregar as interações.");
  }
});

app.post("/api/tasks/:taskId/interactions", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    const taskId = String(req.params.taskId || "").trim();

    if (!taskId) {
      return res.status(400).json({ error: "Tarefa não informada." });
    }

    const { task, role } = await getAccessibleTaskForUser(user.id, taskId);
    const payload = normalizeInteractionPayload(req.body || {});
    const mensagem = String(payload.mensagem || "").trim();

    if (!mensagem) {
      return res.status(400).json({ error: "Digite a mensagem antes de enviar." });
    }

    if (role === "paciente") {
      await assertPatientCanCreateInteraction(task);
    }

    payload.tarefa_id = task.id;
    payload.autor_tipo = role;
    payload.autor_user_id = user.id;
    payload.mensagem = mensagem;

    const encryptedPayload = encryptInteractionSensitiveFields(payload);

    const { data, error } = await supabaseAdmin
      .from("tarefa_interacoes")
      .insert(encryptedPayload)
      .select()
      .single();

    if (error) {
      throw error;
    }

    return res.status(201).json({ interaction: decryptInteractionSensitiveFields(data) });
  } catch (error) {
    return handleApiError(res, error, "Não foi possível criar a interação.");
  }
});

app.patch("/api/tasks/:taskId/interactions/:interactionId", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    const taskId = String(req.params.taskId || "").trim();
    const interactionId = String(req.params.interactionId || "").trim();

    if (!taskId || !interactionId) {
      return res.status(400).json({ error: "Interação não informada." });
    }

    await getAccessibleTaskForUser(user.id, taskId);

    const { data: currentInteraction, error: currentInteractionError } = await supabaseAdmin
      .from("tarefa_interacoes")
      .select("*")
      .eq("id", interactionId)
      .eq("tarefa_id", taskId)
      .maybeSingle();

    if (currentInteractionError) {
      throw currentInteractionError;
    }

    if (!currentInteraction) {
      return res.status(404).json({ error: "Interação não encontrada." });
    }

    if (currentInteraction.autor_user_id !== user.id) {
      return res.status(403).json({ error: "Você não pode alterar esta interação." });
    }

    const payload = normalizeInteractionPayload(req.body || {});
    delete payload.tarefa_id;
    delete payload.autor_tipo;
    delete payload.autor_user_id;

    if (Object.prototype.hasOwnProperty.call(payload, "mensagem")) {
      payload.mensagem = String(payload.mensagem || "").trim();
    }

    if (!payload.mensagem) {
      return res.status(400).json({ error: "Digite a mensagem antes de salvar." });
    }

    const encryptedPayload = encryptInteractionSensitiveFields(payload);

    const { data, error } = await supabaseAdmin
      .from("tarefa_interacoes")
      .update(encryptedPayload)
      .eq("id", interactionId)
      .eq("tarefa_id", taskId)
      .select()
      .single();

    if (error) {
      throw error;
    }

    return res.json({ interaction: decryptInteractionSensitiveFields(data) });
  } catch (error) {
    return handleApiError(res, error, "Não foi possível alterar a interação.");
  }
});

app.get("/api/session-summaries", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    await requireProfessionalProfile(user.id);

    const vinculoId = String(req.query.vinculo_id || "").trim();
    const patientUserId = String(req.query.patient_user_id || "").trim();

    if (!vinculoId || !patientUserId) {
      return res.status(400).json({ error: "Paciente e vínculo são obrigatórios." });
    }

    await verifyActiveProfessionalLink({
      professionalUserId: user.id,
      patientUserId,
      vinculoId
    });

    const { data, error } = await supabaseAdmin
      .from("resumos_sessao")
      .select("id, data_sessao, texto_transcrito, resumo_final, status, created_at, updated_at")
      .eq("professional_user_id", user.id)
      .eq("vinculo_id", vinculoId)
      .order("data_sessao", { ascending: false });

    if (error) {
      throw error;
    }

    return res.json({ summaries: decryptSessionSummarySensitiveRows(data || []) });
  } catch (error) {
    return handleApiError(res, error, "Não foi possível carregar os resumos salvos.");
  }
});

app.get("/api/admin-v2/dataset", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    requireAdminUser(user);

    const { data, error } = await supabaseAdmin.rpc("admin_v2_dataset");

    if (error) {
      throw error;
    }

    return res.json({
      perfis: data?.perfis || [],
      vinculos: data?.vinculos || [],
      convites: data?.convites || [],
      tarefas: decryptTaskSensitiveRows(data?.tarefas || []),
      interacoes: decryptInteractionSensitiveRows(data?.interacoes || []),
      logs: data?.logs || []
    });
  } catch (error) {
    return handleApiError(res, error, "Não foi possível carregar o painel admin-v2.");
  }
});

app.post("/api/session-summaries", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    await requireProfessionalProfile(user.id);

    const payload = normalizeSessionSummaryPayload(req.body || {});
    const vinculoId = String(payload.vinculo_id || "").trim();
    const patientUserId = String(payload.patient_user_id || "").trim();
    const dataSessao = String(payload.data_sessao || "").trim();
    const textoTranscrito = String(payload.texto_transcrito || "").trim();
    const resumoFinal = String(payload.resumo_final || textoTranscrito).trim();

    if (!vinculoId || !patientUserId) {
      return res.status(400).json({ error: "Paciente e vínculo são obrigatórios." });
    }

    if (!dataSessao) {
      return res.status(400).json({ error: "Informe a data da sessão." });
    }

    if (!textoTranscrito && !resumoFinal) {
      return res.status(400).json({ error: "Informe o texto do resumo." });
    }

    const vinculo = await verifyActiveProfessionalLink({
      professionalUserId: user.id,
      patientUserId,
      vinculoId
    });

    payload.vinculo_id = vinculo.id;
    payload.professional_user_id = user.id;
    payload.patient_user_id = patientUserId;
    payload.data_sessao = dataSessao;
    payload.texto_transcrito = textoTranscrito || resumoFinal;
    payload.resumo_final = resumoFinal || textoTranscrito;
    payload.status = String(payload.status || "rascunho").trim() || "rascunho";
    payload.origem_transcricao =
      String(payload.origem_transcricao || "navegador").trim() || "navegador";

    const encryptedPayload = encryptSessionSummarySensitiveFields(payload);

    const { data, error } = await supabaseAdmin
      .from("resumos_sessao")
      .upsert(encryptedPayload, { onConflict: "vinculo_id,data_sessao" })
      .select()
      .single();

    if (error) {
      throw error;
    }

    return res.status(201).json({
      summary: decryptSessionSummarySensitiveFields(data)
    });
  } catch (error) {
    return handleApiError(res, error, "Não foi possível gravar o resumo.");
  }
});

app.delete("/api/session-summaries/:summaryId", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    await requireProfessionalProfile(user.id);

    const summaryId = String(req.params.summaryId || "").trim();

    if (!summaryId) {
      return res.status(400).json({ error: "Resumo não informado." });
    }

    const { data: currentSummary, error: currentSummaryError } = await supabaseAdmin
      .from("resumos_sessao")
      .select("id, professional_user_id")
      .eq("id", summaryId)
      .maybeSingle();

    if (currentSummaryError) {
      throw currentSummaryError;
    }

    if (!currentSummary) {
      return res.status(404).json({ error: "Resumo não encontrado." });
    }

    if (currentSummary.professional_user_id !== user.id) {
      return res.status(403).json({ error: "Você não pode excluir este resumo." });
    }

    const { error } = await supabaseAdmin
      .from("resumos_sessao")
      .delete()
      .eq("id", summaryId)
      .eq("professional_user_id", user.id);

    if (error) {
      throw error;
    }

    return res.json({ ok: true });
  } catch (error) {
    return handleApiError(res, error, "Não foi possível excluir o resumo.");
  }
});

function montarPromptDaTarefa({ title, description, promptComplement, parameters = {} }) {
  const parameterLines = [
    parameters.age_range ? `Faixa etária: ${parameters.age_range}` : null,
    parameters.goal ? `Objetivo principal da tarefa: ${parameters.goal}` : null,
    parameters.tone ? `Tom da linguagem: ${parameters.tone}` : null,
    parameters.estimated_time ? `Tempo estimado: ${parameters.estimated_time}` : null,
    parameters.format ? `Formato da atividade: ${parameters.format}` : null,
    parameters.frequency ? `Frequência sugerida: ${parameters.frequency}` : null,
    parameters.context ? `Contexto principal: ${parameters.context}` : null,
    parameters.observe_after
      ? `Pontos para a profissional observar depois: ${parameters.observe_after}`
      : null
  ].filter(Boolean);

  return [
    "Você está ajudando uma profissional a criar uma tarefa terapêutica prática para paciente.",
    "Gere um material inicial claro, acolhedor, objetivo e utilizável em contexto clínico.",
    "Não cite diagnóstico, não faça promessas de cura e não use linguagem excessivamente técnica.",
    "Responda apenas em JSON válido, sem markdown, com estas chaves:",
    "title, summary, objective, instructions, reflection_questions, closing_message",
    "",
    `Título da tarefa: ${title}`,
    `Descrição da tarefa: ${description}`,
    parameterLines.length ? parameterLines.join("\n") : "Parâmetros adicionais: nenhum",
    promptComplement
      ? `Complementos da profissional para a IA: ${promptComplement}`
      : "Complementos da profissional para a IA: nenhum",
    "",
    "Regras:",
    "- summary: uma frase curta explicando a proposta do material",
    "- objective: um parágrafo curto",
    "- instructions: array com 3 a 6 passos curtos",
    "- reflection_questions: array com 3 a 5 perguntas curtas",
    "- closing_message: um parágrafo curto de encerramento acolhedor"
  ].join("\n");
}

function montarPromptDoParecer({
  patientName,
  taskTitle,
  taskDescription,
  taskOrigin,
  taskInteractionPolicy,
  snippets = [],
  timelineSummary = [],
  interactions = []
}) {
  const safeSnippets = (snippets || [])
    .map((item, index) =>
      `${index + 1}. [${item.author}] ${item.created_at || "-"} :: ${String(item.text || "").trim()}`
    )
    .join("\n");

  const safeTimeline = (timelineSummary || [])
    .map((item, index) => `${index + 1}. ${String(item || "").trim()}`)
    .join("\n");

  const safeInteractions = (interactions || [])
    .map(
      (item, index) =>
        `${index + 1}. [${item.author}] ${item.created_at || "-"} :: ${String(item.text || "").trim()}`
    )
    .join("\n");

  return [
    "Você vai apoiar uma profissional com um parecer de andamento de tarefa terapêutica.",
    "Isto é apoio ao profissional, não conclusão clínica automática ou diagnóstico.",
    "Evite linguagem diagnóstica fechada.",
    "Mostre sempre as evidências do próprio histórico que sustentam o parecer.",
    "Não invente fatos ausentes do material.",
    "Diferencie observação de inferência.",
    "Responda apenas em JSON válido, sem markdown, com estas chaves:",
    "resumo_andamento, sinais_avanco, pontos_atencao, hipoteses_compreensao, sugestoes_proxima_conducao, trechos_relevantes, mudanca_percebida",
    "",
    `Paciente: ${patientName || "Paciente"}`,
    `Título da tarefa: ${taskTitle || "Sem título"}`,
    `Descrição da tarefa: ${taskDescription || "Sem descrição"}`,
    `Origem da tarefa: ${taskOrigin || "Não informada"}`,
    `Política de interação: ${taskInteractionPolicy || "Não informada"}`,
    "",
    "Trechos relevantes já destacados:",
    safeSnippets || "Nenhum trecho relevante informado.",
    "",
    "Mudança percebida ao longo do tempo:",
    safeTimeline || "Nenhuma mudança percebida resumida.",
    "",
    "Histórico completo das interações:",
    safeInteractions || "Nenhuma interação registrada.",
    "",
    "Regras de formato:",
    "- resumo_andamento: um parágrafo curto",
    "- sinais_avanco: array com 2 a 5 itens",
    "- pontos_atencao: array com 2 a 5 itens",
    "- hipoteses_compreensao: array com 2 a 5 itens",
    "- sugestoes_proxima_conducao: array com 2 a 5 itens",
    "- trechos_relevantes: array com 2 a 5 itens; cada item deve citar o sentido clínico do trecho",
    "- mudanca_percebida: um parágrafo curto descrevendo o que parece ter mudado ao longo do tempo"
  ].join("\n");
}

function montarPromptDoInfografico({ tema, personagem, observacoes }) {
  return [
    "Você cria conteúdo para um infográfico terapêutico psicoeducativo.",
    "O conteúdo será revisado por profissional. Não diagnostique, não prometa cura e não substitua atendimento.",
    "Use português do Brasil, linguagem acolhedora, clara e útil para celular.",
    "Antes de responder, faça revisão gramatical e ortográfica completa de todos os textos.",
    "Revise também o teor psicoeducativo: use informações conservadoras, seguras e compatíveis com fontes confiáveis da área de saúde, como Fiocruz, Ministério da Saúde, OMS/OPAS e materiais técnicos reconhecidos.",
    "Não invente dados, percentuais, recomendações clínicas específicas ou orientações médicas. Se o tema exigir cuidado especializado, use orientação geral de buscar ajuda profissional.",
    "Responda apenas em JSON válido, sem markdown, com estas chaves:",
    "tarefa, titulo, contexto, faixa_amarela, desafios, perguntas_reflexao, o_que_pode_ajudar, frase_final",
    "",
    `Tema: ${tema}`,
    `Personagem escolhido: ${personagem}`,
    observacoes ? `Observações da profissional: ${observacoes}` : "Observações da profissional: nenhuma",
    "",
    "Regras fixas:",
    "- tarefa: sempre 'TAREFA 5'",
    "- titulo: até 7 palavras",
    "- contexto: 2 frases curtas, acolhedoras e práticas",
    "- faixa_amarela: uma chamada curta com até 8 palavras",
    "- desafios: array com exatamente 6 itens; cada item com até 3 palavras",
    "- perguntas_reflexao: array com exatamente 3 perguntas curtas",
    "- o_que_pode_ajudar: array com exatamente 6 itens curtos",
    "- frase_final: uma frase acolhedora com até 14 palavras"
  ].join("\n");
}

function montarPromptDaImagemDoInfografico({ tema, personagem, observacoes, quality }) {
  const styleByQuality = {
    low: [
      "Style: simple flat digital illustration, clean Canva-like drawing, soft rounded shapes, minimal details, friendly colors.",
      "Avoid: photorealism, 3D render, cinematic lighting, overly detailed backgrounds."
    ],
    medium: [
      "Style: premium 3D animated movie look, expressive character, soft cinematic lighting, rounded forms, warm emotional tone, polished but still family-friendly.",
      "Avoid: flat vector style, photorealism, brand-specific character styles, text, logos."
    ],
    high: [
      "Style: photorealistic professional lifestyle photography, natural light, real human emotion, realistic environment, shallow depth of field, editorial quality.",
      "Avoid: illustration, cartoon, 3D render, plastic skin, exaggerated expressions, text, logos."
    ]
  };
  const styleRules = styleByQuality[quality] || styleByQuality.low;

  return [
    quality === "high"
      ? "Create a therapeutic photorealistic image for a mental health infographic."
      : "Create a therapeutic image for a mental health infographic.",
    "No text, no letters, no watermark, no logos.",
    "Subject:",
    `${personagem} dealing with ${tema} in a calm, supportive, non-clinical environment.`,
    observacoes ? `Context note: ${observacoes}.` : "",
    ...styleRules,
    "Composition: horizontal landscape image, 3:2 aspect ratio, character visible from waist up, generous scene context, suitable for a wide top banner inside a fixed infographic template.",
    "Palette: white, purple #6F2DBD, deep blue #1E3A8A, soft blue #E8F0FF, small green accents #16A34A.",
    "Avoid: scary mood, medical equipment, hospital scene, captions, diagnosis labels."
  ]
    .filter(Boolean)
    .join("\n");
}

function slugify(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function stripMarkdownCodeFences(value) {
  const text = String(value || "").trim();
  if (!text) return "";

  const fencedMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fencedMatch) {
    return String(fencedMatch[1] || "").trim();
  }

  return text;
}

function tryParseJsonObject(value) {
  const cleaned = stripMarkdownCodeFences(value);
  if (!cleaned) return null;

  try {
    return JSON.parse(cleaned);
  } catch {
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const possibleJson = cleaned.slice(firstBrace, lastBrace + 1);
      try {
        return JSON.parse(possibleJson);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function extractParecerText(value) {
  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => extractParecerText(item))
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (value && typeof value === "object") {
    const candidateKeys = [
      "text",
      "content",
      "output_text",
      "response",
      "message",
      "result",
      "value",
      "body"
    ];

    for (const key of candidateKeys) {
      const extracted = extractParecerText(value[key]);
      if (extracted) return extracted;
    }

    const nestedValues = Object.values(value)
      .map((item) => extractParecerText(item))
      .filter(Boolean);

    if (nestedValues.length) {
      return nestedValues.join(" ").trim();
    }
  }

  return "";
}

function normalizeParecerSectionList(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => extractParecerText(item))
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }

  const text = extractParecerText(value);
  if (!text) return [];

  return text
    .split(/\n+/)
    .map((item) => item.replace(/^[-•\d.)\s]+/, "").trim())
    .filter(Boolean);
}

function normalizeParecerResponse(payload, rawContent = "") {
  const source = payload && typeof payload === "object" ? payload : {};

  const resumo =
    String(
      source.resumo_andamento ??
        source.resumo ??
        source.summary ??
        source.parecer ??
        ""
    ).trim();

  const mudanca =
    String(
      source.mudanca_percebida ??
        source.mudancas_percebidas ??
        source.evolucao_percebida ??
        ""
    ).trim();

  const normalized = {
    resumo_andamento: resumo || String(rawContent || "").trim(),
    sinais_avanco: normalizeParecerSectionList(
      source.sinais_avanco ?? source.avancos ?? source.sinais_de_avanco
    ),
    pontos_atencao: normalizeParecerSectionList(
      source.pontos_atencao ?? source.atencao ?? source.pontos_de_atencao
    ),
    hipoteses_compreensao: normalizeParecerSectionList(
      source.hipoteses_compreensao ?? source.hipoteses ?? source.compreensao
    ),
    sugestoes_proxima_conducao: normalizeParecerSectionList(
      source.sugestoes_proxima_conducao ?? source.sugestoes ?? source.proxima_conducao
    ),
    trechos_relevantes: normalizeParecerSectionList(
      source.trechos_relevantes ?? source.evidencias ?? source.trechos
    ),
    mudanca_percebida: mudanca || "Sem mudanca percebida registrada."
  };

  return normalized;
}

function sanitizePdfText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[^\x09\x0A\x0D\x20-\xFF]/g, "");
}

function decodeBase64File(fileBase64) {
  const cleanBase64 = String(fileBase64 || "").replace(/^data:.*;base64,/, "").trim();
  if (!cleanBase64) {
    throw new Error("Nenhum arquivo PDF foi enviado.");
  }

  return Buffer.from(cleanBase64, "base64");
}

function buildStoragePaths({ userId, fileName, scope = "manual", themeName = "", resourceName = "" }) {
  const baseName = String(fileName || "material").replace(/\.pdf$/i, "");
  const safeBase = slugify(baseName) || "material";
  const safeTheme = slugify(themeName) || "tema";
  const safeResource = slugify(resourceName) || safeBase;

  if (scope === "banco-tarefas") {
    const finalBase = `${Date.now()}-${safeTheme}-${safeResource}`;
    const baseDir = `banco-tarefas/${safeTheme}`;

    return {
      pdfPath: `${baseDir}/${finalBase}.pdf`,
      previewPath: `${baseDir}/previews/${finalBase}.png`
    };
  }

  if (!String(userId || "").trim()) {
    throw new Error("Usuário inválido para armazenar o PDF.");
  }

  const finalBase = `${Date.now()}-${safeBase}`;
  const baseDir = `${userId}/manual`;

  return {
    pdfPath: `${baseDir}/${finalBase}.pdf`,
    previewPath: `${baseDir}/previews/${finalBase}.png`
  };
}

async function gerarMiniaturaDoPdf(pdfBuffer) {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    standardFontDataUrl: PDF_STANDARD_FONTS_URL
  });

  const pdfDocument = await loadingTask.promise;
  const firstPage = await pdfDocument.getPage(1);
  const baseViewport = firstPage.getViewport({ scale: 1 });
  const targetWidth = 1200;
  const scale = targetWidth / baseViewport.width;
  const viewport = firstPage.getViewport({ scale });

  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext("2d");

  await firstPage.render({
    canvasContext: context,
    viewport
  }).promise;

  return canvas.toBuffer("image/png");
}

async function uploadTaskAssetToStorage(storagePath, fileBuffer, contentType) {
  return uploadTaskAssetToBucket(TASK_PDF_BUCKET, storagePath, fileBuffer, contentType);
}

async function ensureStorageBucket(bucketName, options = {}) {
  if (!supabaseAdmin) {
    throw new Error("As credenciais de serviço do Supabase ainda não foram configuradas no backend.");
  }

  const { data: buckets, error: listError } = await supabaseAdmin.storage.listBuckets();
  if (listError) {
    throw new Error(`Falha ao listar buckets do storage: ${listError.message}`);
  }

  const exists = Array.isArray(buckets) && buckets.some((bucket) => bucket.name === bucketName);
  if (exists) {
    return;
  }

  const { error: createError } = await supabaseAdmin.storage.createBucket(bucketName, options);
  if (createError && !/already exists/i.test(createError.message || "")) {
    throw new Error(`Falha ao criar bucket ${bucketName}: ${createError.message}`);
  }
}

async function uploadTaskAssetToBucket(bucketName, storagePath, fileBuffer, contentType) {
  if (!supabaseAdmin) {
    throw new Error("As credenciais de serviço do Supabase ainda não foram configuradas no backend.");
  }

  const { error } = await supabaseAdmin.storage.from(bucketName).upload(storagePath, fileBuffer, {
    cacheControl: "3600",
    upsert: false,
    contentType
  });

  if (error) {
    throw new Error(`Falha ao enviar arquivo para o storage: ${error.message}`);
  }
}

function wrapText(text, font, fontSize, maxWidth) {
  const safeText = sanitizePdfText(text).replace(/\s+/g, " ").trim();
  if (!safeText) return [""];

  const words = safeText.split(" ");
  const lines = [];
  let current = words[0] || "";

  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    const candidate = `${current} ${word}`;

    if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }

  lines.push(current);
  return lines;
}

function drawWrappedText(page, text, options) {
  const {
    x,
    y,
    width,
    font,
    fontSize = 12,
    lineHeight = fontSize * 1.45,
    color = rgb(0.2, 0.24, 0.33)
  } = options;

  const paragraphs = sanitizePdfText(text)
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);

  let cursorY = y;

  paragraphs.forEach((paragraph, paragraphIndex) => {
    const lines = wrapText(paragraph, font, fontSize, width);

    lines.forEach((line) => {
      page.drawText(line, {
        x,
        y: cursorY,
        size: fontSize,
        font,
        color
      });
      cursorY -= lineHeight;
    });

    if (paragraphIndex < paragraphs.length - 1) {
      cursorY -= lineHeight * 0.4;
    }
  });

  return cursorY;
}

function drawBulletList(page, items, options) {
  const {
    x,
    y,
    width,
    font,
    fontSize = 12,
    lineHeight = fontSize * 1.45,
    color = rgb(0.2, 0.24, 0.33)
  } = options;

  let cursorY = y;

  (items || []).forEach((item) => {
    const text = sanitizePdfText(item).trim();
    if (!text) return;

    const bulletX = x;
    const contentX = x + 14;
    const availableWidth = Math.max(width - 14, 60);
    const lines = wrapText(text, font, fontSize, availableWidth);

    page.drawText("•", {
      x: bulletX,
      y: cursorY,
      size: fontSize,
      font,
      color
    });

    lines.forEach((line, index) => {
      page.drawText(line, {
        x: contentX,
        y: cursorY - index * lineHeight,
        size: fontSize,
        font,
        color
      });
    });

    cursorY -= lines.length * lineHeight + 4;
  });

  return cursorY;
}

async function gerarPdfDaTarefa({ title, description, material, patientName, professionalName }) {
  const pdfDoc = await PDFDocument.create();
  const pageSize = [595.28, 841.89];
  let page = null;
  let width = pageSize[0];
  let height = pageSize[1];
  const marginX = 48;
  const topMargin = 60;
  const bottomMargin = 52;
  const contentWidth = width - marginX * 2;
  const titleColor = rgb(0.33, 0.28, 0.94);
  const bodyColor = rgb(0.2, 0.24, 0.33);
  const subtleColor = rgb(0.42, 0.47, 0.56);
  const borderColor = rgb(0.88, 0.9, 0.95);

  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  function drawPageFrame(targetPage) {
    targetPage.drawRectangle({
      x: 24,
      y: 24,
      width: width - 48,
      height: height - 48,
      borderColor,
      borderWidth: 1,
      borderRadius: 24
    });
  }

  function createPage() {
    page = pdfDoc.addPage(pageSize);
    width = page.getWidth();
    height = page.getHeight();
    drawPageFrame(page);
    return height - topMargin;
  }

  function ensureSpace(cursorY, requiredHeight) {
    if (cursorY - requiredHeight >= bottomMargin) {
      return { page, cursorY };
    }

    return {
      page,
      cursorY: createPage()
    };
  }

  function drawWrappedTextPaged(text, options) {
    const {
      x,
      y,
      width,
      font,
      fontSize = 12,
      lineHeight = fontSize * 1.45,
      color = rgb(0.2, 0.24, 0.33),
      paragraphSpacing = lineHeight * 0.4
    } = options;

    const paragraphs = sanitizePdfText(text)
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);

    let cursorY = y;

    paragraphs.forEach((paragraph, paragraphIndex) => {
      const lines = wrapText(paragraph, font, fontSize, width);

      lines.forEach((line) => {
        ({ cursorY } = ensureSpace(cursorY, lineHeight));

        page.drawText(line, {
          x,
          y: cursorY,
          size: fontSize,
          font,
          color
        });

        cursorY -= lineHeight;
      });

      if (paragraphIndex < paragraphs.length - 1) {
        cursorY -= paragraphSpacing;
      }
    });

    return cursorY;
  }

  function drawBulletListPaged(items, options) {
    const {
      x,
      y,
      width,
      font,
      fontSize = 12,
      lineHeight = fontSize * 1.45,
      color = rgb(0.2, 0.24, 0.33),
      itemSpacing = 4
    } = options;

    let cursorY = y;

    (items || []).forEach((item) => {
      const text = sanitizePdfText(item).trim();
      if (!text) return;

      const bulletX = x;
      const contentX = x + 14;
      const availableWidth = Math.max(width - 14, 60);
      const lines = wrapText(text, font, fontSize, availableWidth);

      lines.forEach((line, index) => {
        ({ cursorY } = ensureSpace(cursorY, lineHeight));

        if (index === 0) {
          page.drawText("•", {
            x: bulletX,
            y: cursorY,
            size: fontSize,
            font,
            color
          });
        }

        page.drawText(line, {
          x: contentX,
          y: cursorY,
          size: fontSize,
          font,
          color
        });

        cursorY -= lineHeight;
      });

      cursorY -= itemSpacing;
    });

    return cursorY;
  }

  function drawSectionTitle(text, cursorY) {
    ({ cursorY } = ensureSpace(cursorY, 22));

    page.drawText(text, {
      x: marginX,
      y: cursorY,
      size: 14,
      font: fontBold,
      color: titleColor
    });

    return cursorY - 22;
  }

  function drawMetaBox(cursorY) {
    const boxHeight = 52;
    ({ cursorY } = ensureSpace(cursorY, boxHeight + 10));

    page.drawRectangle({
      x: marginX,
      y: cursorY - boxHeight,
      width: contentWidth,
      height: boxHeight,
      color: rgb(0.97, 0.98, 1),
      borderColor: rgb(0.86, 0.88, 0.97),
      borderWidth: 1,
      borderRadius: 16
    });

    page.drawText(`Paciente: ${sanitizePdfText(patientName || "Paciente")}`, {
      x: marginX + 16,
      y: cursorY - 20,
      size: 11,
      font: fontBold,
      color: subtleColor
    });

    page.drawText(`Profissional: ${sanitizePdfText(professionalName || "Profissional")}`, {
      x: marginX + 16,
      y: cursorY - 36,
      size: 11,
      font: fontRegular,
      color: subtleColor
    });

    return cursorY - 78;
  }

  let cursorY = createPage();

  page.drawText("Tarefa terapêutica", {
    x: marginX,
    y: cursorY,
    size: 13,
    font: fontBold,
    color: titleColor
  });

  cursorY -= 34;
  cursorY = drawWrappedTextPaged(material?.title || title || "Tarefa", {
    x: marginX,
    y: cursorY,
    width: contentWidth,
    font: fontBold,
    fontSize: 28,
    lineHeight: 32,
    color: rgb(0.12, 0.14, 0.19)
  });

  cursorY -= 8;
  cursorY = drawWrappedTextPaged(material?.summary || description || "", {
    x: marginX,
    y: cursorY,
    width: contentWidth,
    font: fontRegular,
    fontSize: 13,
    lineHeight: 18,
    color: subtleColor
  });

  cursorY -= 16;
  cursorY = drawMetaBox(cursorY);

  cursorY = drawSectionTitle("Objetivo", cursorY);
  cursorY = drawWrappedTextPaged(material?.objective || "", {
    x: marginX,
    y: cursorY,
    width: contentWidth,
    font: fontRegular,
    fontSize: 12,
    lineHeight: 18,
    color: bodyColor
  });

  cursorY -= 18;
  cursorY = drawSectionTitle("Como aplicar", cursorY);
  cursorY = drawBulletListPaged(material?.instructions || [], {
    x: marginX,
    y: cursorY,
    width: contentWidth,
    font: fontRegular,
    fontSize: 12,
    lineHeight: 18,
    color: bodyColor
  });

  cursorY -= 10;
  cursorY = drawSectionTitle("Perguntas guiadas", cursorY);
  cursorY = drawBulletListPaged(material?.reflection_questions || [], {
    x: marginX,
    y: cursorY,
    width: contentWidth,
    font: fontRegular,
    fontSize: 12,
    lineHeight: 18,
    color: bodyColor
  });

  cursorY -= 6;
  cursorY = drawSectionTitle("Fechamento", cursorY);
  drawWrappedTextPaged(material?.closing_message || "", {
    x: marginX,
    y: cursorY,
    width: contentWidth,
    font: fontRegular,
    fontSize: 12,
    lineHeight: 18,
    color: bodyColor
  });

  return pdfDoc.save();
}

async function enviarPdfGeradoParaStorage({ userId, title, pdfBytes }) {
  if (!supabaseAdmin) {
    throw new Error("As credenciais de serviço do Supabase ainda não foram configuradas no backend.");
  }

  const safeTitle = slugify(title || "tarefa") || "tarefa";
  const fileName = `${safeTitle}-${Date.now()}.pdf`;
  const filePath = `${userId}/ia/${fileName}`;
  const fileBuffer = Buffer.from(pdfBytes);

  const { error } = await supabaseAdmin.storage
    .from(TASK_PDF_BUCKET)
    .upload(filePath, fileBuffer, {
      cacheControl: "3600",
      upsert: false,
      contentType: "application/pdf"
    });

  if (error) {
    throw new Error(`Falha ao enviar PDF gerado: ${error.message}`);
  }

  return {
    pdfPath: filePath,
    pdfName: fileName
  };
}

app.post("/api/storage/upload-task-pdf", async (req, res) => {
  const {
    userId = "",
    fileName = "",
    fileBase64 = "",
    scope = "manual",
    themeName = "",
    resourceName = ""
  } = req.body || {};

  if (!fileName.trim()) {
    return res.status(400).json({
      error: "Informe o nome do arquivo PDF."
    });
  }

  try {
    const pdfBuffer = decodeBase64File(fileBase64);
    const { pdfPath, previewPath } = buildStoragePaths({
      userId,
      fileName,
      scope,
      themeName,
      resourceName
    });

    const previewBuffer = await gerarMiniaturaDoPdf(pdfBuffer);

    await ensureStorageBucket(TASK_PDF_PREVIEW_BUCKET, {
      public: false,
      fileSizeLimit: "10MB",
      allowedMimeTypes: ["image/png"]
    });

    await uploadTaskAssetToStorage(pdfPath, pdfBuffer, "application/pdf");
    await uploadTaskAssetToBucket(TASK_PDF_PREVIEW_BUCKET, previewPath, previewBuffer, "image/png");

    return res.json({
      pdfPath,
      pdfName: fileName,
      previewPath,
      previewBucket: TASK_PDF_PREVIEW_BUCKET
    });
  } catch (error) {
    console.error("Erro ao enviar PDF com preview:", error);
    return res.status(500).json({
      error: error.message || "Não foi possível enviar o PDF com preview."
    });
  }
});

async function chamarOpenAiParaPrevia({ title, description, promptComplement, parameters, model }) {
  const response = await fetch(OPENAI_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content:
            "Você gera materiais terapêuticos iniciais em JSON claro e bem estruturado para revisão profissional."
        },
        {
          role: "user",
          content: montarPromptDaTarefa({
            title: title.trim(),
            description: description.trim(),
            promptComplement: promptComplement.trim(),
            parameters
          })
        }
      ]
    })
  });

  const payload = await response.json();

  if (!response.ok) {
    const apiError =
      payload?.error?.message || "A OpenAI não conseguiu gerar o material neste momento.";
    throw new Error(apiError);
  }

  const content = payload?.choices?.[0]?.message?.content?.trim();

  if (!content) {
    throw new Error("A IA não retornou conteúdo para esta tarefa.");
  }

  try {
    return JSON.parse(content);
  } catch (parseError) {
    return {
      title: title.trim(),
      summary: "Prévia gerada pela IA.",
      raw_text: content
    };
  }
}

async function chamarOpenAiParaParecer({
  patientName,
  taskTitle,
  taskDescription,
  taskOrigin,
  taskInteractionPolicy,
  snippets,
  timelineSummary,
  interactions,
  model
}) {
  const response = await fetch(OPENAI_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      messages: [
        {
          role: "system",
          content:
            "Você escreve pareceres de andamento de tarefa terapêutica como apoio ao profissional, sem diagnosticar."
        },
        {
          role: "user",
          content: montarPromptDoParecer({
            patientName,
            taskTitle,
            taskDescription,
            taskOrigin,
            taskInteractionPolicy,
            snippets,
            timelineSummary,
            interactions
          })
        }
      ]
    })
  });

  const payload = await response.json();

  if (!response.ok) {
    const apiError =
      payload?.error?.message || "A OpenAI não conseguiu gerar o parecer neste momento.";
    throw new Error(apiError);
  }

  const content = payload?.choices?.[0]?.message?.content?.trim();

  if (!content) {
    throw new Error("A IA não retornou conteúdo para este parecer.");
  }

  const parsed = tryParseJsonObject(content);

  if (parsed) {
    return normalizeParecerResponse(parsed, content);
  }

  return normalizeParecerResponse({}, stripMarkdownCodeFences(content));
}

async function chamarOpenAiParaInfografico({ tema, personagem, observacoes, model }) {
  const response = await fetch(OPENAI_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.55,
      messages: [
        {
          role: "system",
          content:
            "Você gera conteúdo terapêutico psicoeducativo em JSON válido para ser diagramado em template fixo."
        },
        {
          role: "user",
          content: montarPromptDoInfografico({ tema, personagem, observacoes })
        }
      ]
    })
  });

  const payload = await response.json();

  if (!response.ok) {
    const apiError =
      payload?.error?.message || "A OpenAI não conseguiu gerar o conteúdo do infográfico.";
    throw new Error(apiError);
  }

  const content = payload?.choices?.[0]?.message?.content?.trim();
  const parsed = tryParseJsonObject(content);

  if (!parsed) {
    throw new Error("A IA não retornou JSON válido para o infográfico.");
  }

  return {
    tarefa: String(parsed.tarefa || "TAREFA 5").trim(),
    titulo: String(parsed.titulo || `Trabalhando ${tema}`).trim(),
    contexto: String(parsed.contexto || "").trim(),
    faixa_amarela: String(parsed.faixa_amarela || `Desafios de ${tema}`).trim(),
    desafios: normalizeParecerSectionList(parsed.desafios).slice(0, 6),
    perguntas_reflexao: normalizeParecerSectionList(parsed.perguntas_reflexao).slice(0, 3),
    o_que_pode_ajudar: normalizeParecerSectionList(parsed.o_que_pode_ajudar).slice(0, 6),
    frase_final: String(parsed.frase_final || "").trim()
  };
}

function aplicarCaixaAltaNoInfografico(conteudo) {
  const upper = (value) => String(value || "").trim().toLocaleUpperCase("pt-BR");

  return {
    tarefa: upper(conteudo?.tarefa),
    titulo: upper(conteudo?.titulo),
    contexto: upper(conteudo?.contexto),
    faixa_amarela: upper(conteudo?.faixa_amarela),
    desafios: Array.isArray(conteudo?.desafios) ? conteudo.desafios.map(upper) : [],
    perguntas_reflexao: Array.isArray(conteudo?.perguntas_reflexao)
      ? conteudo.perguntas_reflexao.map(upper)
      : [],
    o_que_pode_ajudar: Array.isArray(conteudo?.o_que_pode_ajudar)
      ? conteudo.o_que_pode_ajudar.map(upper)
      : [],
    frase_final: upper(conteudo?.frase_final),
    texto_complementar: upper(conteudo?.texto_complementar)
  };
}

async function chamarOpenAiParaImagemInfografico({ tema, personagem, observacoes, quality }) {
  const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
  const response = await fetch(OPENAI_IMAGE_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model,
      prompt: montarPromptDaImagemDoInfografico({ tema, personagem, observacoes, quality }),
      size: process.env.OPENAI_INFOGRAPHIC_IMAGE_SIZE || "1536x1024",
      quality,
      n: 1
    })
  });

  const payload = await response.json();

  if (!response.ok) {
    const apiError =
      payload?.error?.message || "A OpenAI não conseguiu gerar a imagem do infográfico.";
    throw new Error(apiError);
  }

  const imageData = payload?.data?.[0] || {};
  const base64 = imageData.b64_json || "";
  const imageUrl = imageData.url || "";

  if (base64) {
    return `data:image/png;base64,${base64}`;
  }

  if (imageUrl) {
    return imageUrl;
  }

  throw new Error("A IA não retornou uma imagem válida.");
}

app.post("/api/ai/task-material-preview", async (req, res) => {
  const {
    title = "",
    description = "",
    promptComplement = "",
    parameters = {}
  } = req.body || {};

  if (!title.trim() || !description.trim()) {
    return res.status(400).json({
      error: "Informe título e descrição para gerar o material com IA."
    });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({
      error: "A chave da OpenAI ainda não foi configurada no backend."
    });
  }

  const model = process.env.OPENAI_TASKS_MODEL || process.env.OPENAI_MODEL || "gpt-5.4-mini";

  try {
    const material = await chamarOpenAiParaPrevia({
      title,
      description,
      promptComplement,
      parameters,
      model
    });

    return res.json({ material });
  } catch (error) {
    console.error("Erro ao gerar material com IA:", error);
    return res.status(500).json({
      error: error.message || "Não foi possível gerar o material com IA."
    });
  }
});

app.post("/api/ai/task-material-pdf", async (req, res) => {
  const {
    userId = "",
    title = "",
    description = "",
    material = null,
    patientName = "",
    professionalName = ""
  } = req.body || {};

  if (!userId.trim() || !title.trim()) {
    return res.status(400).json({
      error: "Informe usuário e título da tarefa para gerar o PDF."
    });
  }

  if (!material || typeof material !== "object") {
    return res.status(400).json({
      error: "Nenhuma prévia válida foi enviada para gerar o PDF."
    });
  }

  try {
    const pdfBytes = await gerarPdfDaTarefa({
      title: title.trim(),
      description: description.trim(),
      material,
      patientName,
      professionalName
    });

    const uploaded = await enviarPdfGeradoParaStorage({
      userId: userId.trim(),
      title: material.title || title,
      pdfBytes
    });

    return res.json(uploaded);
  } catch (error) {
    console.error("Erro ao gerar PDF da tarefa com IA:", error);
    return res.status(500).json({
      error: error.message || "Não foi possível gerar o PDF da tarefa com IA."
    });
  }
});

app.post("/api/ai/meu-infografico", async (req, res) => {
  const {
    tema = "",
    personagem = "",
    observacoes = "",
    textoComplementar = "",
    qualidade = "low",
    caixaAlta = true
  } = req.body || {};

  const temaNormalizado = String(tema || "").trim();
  const personagemNormalizado = String(personagem || "").trim();
  const observacoesNormalizadas = String(observacoes || "").trim();
  const textoComplementarNormalizado = String(textoComplementar || "").trim();
  const qualidadeNormalizada = ["low", "medium", "high"].includes(String(qualidade))
    ? String(qualidade)
    : "low";
  const deveUsarCaixaAlta = caixaAlta !== false;

  if (!temaNormalizado || !personagemNormalizado) {
    return res.status(400).json({
      error: "Informe tema e personagem para gerar o infográfico."
    });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({
      error: "A chave da OpenAI ainda não foi configurada no backend."
    });
  }

  const model = process.env.OPENAI_TASKS_MODEL || process.env.OPENAI_MODEL || "gpt-5.4-mini";

  try {
    const [conteudoGerado, imagemUrl] = await Promise.all([
      chamarOpenAiParaInfografico({
        tema: temaNormalizado,
        personagem: personagemNormalizado,
        observacoes: observacoesNormalizadas,
        model
      }),
      chamarOpenAiParaImagemInfografico({
        tema: temaNormalizado,
        personagem: personagemNormalizado,
        observacoes: observacoesNormalizadas,
        quality: qualidadeNormalizada
      })
    ]);
    const conteudoComComplemento = {
      ...conteudoGerado,
      texto_complementar: textoComplementarNormalizado
    };
    const conteudo = deveUsarCaixaAlta
      ? aplicarCaixaAltaNoInfografico(conteudoComComplemento)
      : conteudoComComplemento;

    return res.json({
      conteudo,
      imagemUrl,
      qualidade: qualidadeNormalizada,
      caixaAlta: deveUsarCaixaAlta
    });
  } catch (error) {
    console.error("Erro ao gerar meu infográfico:", error);
    return res.status(500).json({
      error: error.message || "Não foi possível gerar o infográfico."
    });
  }
});

async function handleTaskProgressOpinion(req, res) {
  const {
    patientName = "",
    taskTitle = "",
    taskDescription = "",
    taskOrigin = "",
    taskInteractionPolicy = "",
    snippets = [],
    timelineSummary = [],
    interactions = []
  } = req.body || {};

  if (!taskTitle.trim()) {
    return res.status(400).json({
      error: "Informe a tarefa para gerar o parecer."
    });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({
      error: "A chave da OpenAI ainda não foi configurada no backend."
    });
  }

  const model = process.env.OPENAI_TASKS_MODEL || process.env.OPENAI_MODEL || "gpt-5.4-mini";

  try {
    const parecer = await chamarOpenAiParaParecer({
      patientName: patientName.trim(),
      taskTitle: taskTitle.trim(),
      taskDescription: taskDescription.trim(),
      taskOrigin: taskOrigin.trim(),
      taskInteractionPolicy: taskInteractionPolicy.trim(),
      snippets: Array.isArray(snippets) ? snippets : [],
      timelineSummary: Array.isArray(timelineSummary) ? timelineSummary : [],
      interactions: Array.isArray(interactions) ? interactions : [],
      model
    });

    return res.json({ parecer });
  } catch (error) {
    console.error("Erro ao gerar parecer com IA:", error);
    return res.status(500).json({
      error: error.message || "Não foi possível gerar o parecer com IA."
    });
  }
}

app.post("/api/ai/task-progress-opinion", handleTaskProgressOpinion);
app.post("/api/ai/task-parecer", handleTaskProgressOpinion);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

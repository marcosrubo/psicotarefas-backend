import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "25mb" }));

const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const TASK_PDF_BUCKET = process.env.TASK_PDF_BUCKET || "banco-tarefas-pdf";
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

app.get("/", (req, res) => {
  res.send("API PsicoTarefas rodando 🚀");
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

function slugify(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
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
  if (!supabaseAdmin) {
    throw new Error("As credenciais de serviço do Supabase ainda não foram configuradas no backend.");
  }

  const { error } = await supabaseAdmin.storage.from(TASK_PDF_BUCKET).upload(storagePath, fileBuffer, {
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
  const page = pdfDoc.addPage([595.28, 841.89]);
  const width = page.getWidth();
  const height = page.getHeight();
  const marginX = 48;
  const contentWidth = width - marginX * 2;
  const titleColor = rgb(0.33, 0.28, 0.94);
  const bodyColor = rgb(0.2, 0.24, 0.33);
  const subtleColor = rgb(0.42, 0.47, 0.56);
  const borderColor = rgb(0.88, 0.9, 0.95);

  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  page.drawRectangle({
    x: 24,
    y: 24,
    width: width - 48,
    height: height - 48,
    borderColor,
    borderWidth: 1,
    borderRadius: 24
  });

  let cursorY = height - 60;

  page.drawText("Tarefa terapêutica", {
    x: marginX,
    y: cursorY,
    size: 13,
    font: fontBold,
    color: titleColor
  });

  cursorY -= 34;
  cursorY = drawWrappedText(page, material?.title || title || "Tarefa", {
    x: marginX,
    y: cursorY,
    width: contentWidth,
    font: fontBold,
    fontSize: 28,
    lineHeight: 32,
    color: rgb(0.12, 0.14, 0.19)
  });

  cursorY -= 8;
  cursorY = drawWrappedText(page, material?.summary || description || "", {
    x: marginX,
    y: cursorY,
    width: contentWidth,
    font: fontRegular,
    fontSize: 13,
    lineHeight: 18,
    color: subtleColor
  });

  cursorY -= 16;

  page.drawRectangle({
    x: marginX,
    y: cursorY - 52,
    width: contentWidth,
    height: 52,
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

  cursorY -= 78;

  page.drawText("Objetivo", {
    x: marginX,
    y: cursorY,
    size: 14,
    font: fontBold,
    color: titleColor
  });

  cursorY -= 22;
  cursorY = drawWrappedText(page, material?.objective || "", {
    x: marginX,
    y: cursorY,
    width: contentWidth,
    font: fontRegular,
    fontSize: 12,
    lineHeight: 18,
    color: bodyColor
  });

  cursorY -= 18;
  page.drawText("Como aplicar", {
    x: marginX,
    y: cursorY,
    size: 14,
    font: fontBold,
    color: titleColor
  });

  cursorY -= 22;
  cursorY = drawBulletList(page, material?.instructions || [], {
    x: marginX,
    y: cursorY,
    width: contentWidth,
    font: fontRegular,
    fontSize: 12,
    lineHeight: 18,
    color: bodyColor
  });

  cursorY -= 10;
  page.drawText("Perguntas guiadas", {
    x: marginX,
    y: cursorY,
    size: 14,
    font: fontBold,
    color: titleColor
  });

  cursorY -= 22;
  cursorY = drawBulletList(page, material?.reflection_questions || [], {
    x: marginX,
    y: cursorY,
    width: contentWidth,
    font: fontRegular,
    fontSize: 12,
    lineHeight: 18,
    color: bodyColor
  });

  cursorY -= 6;
  page.drawText("Fechamento", {
    x: marginX,
    y: cursorY,
    size: 14,
    font: fontBold,
    color: titleColor
  });

  cursorY -= 22;
  drawWrappedText(page, material?.closing_message || "", {
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

    await uploadTaskAssetToStorage(pdfPath, pdfBuffer, "application/pdf");
    await uploadTaskAssetToStorage(previewPath, previewBuffer, "image/png");

    return res.json({
      pdfPath,
      pdfName: fileName,
      previewPath
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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

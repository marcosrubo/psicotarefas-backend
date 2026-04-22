import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("API PsicoTarefas rodando 🚀");
});

function montarPromptDaTarefa({ title, description, promptComplement }) {
  return [
    "Você está ajudando uma profissional a criar uma tarefa terapêutica prática para paciente.",
    "Gere um material inicial claro, acolhedor, objetivo e utilizável em contexto clínico.",
    "O material deve seguir sempre a mesma estrutura, para virar uma ficha padronizada no sistema.",
    "Seja criativo e diversifique os formatos das perguntas e da proposta, sem perder coerência clínica.",
    "A tarefa deve poder servir de base para diferentes abordagens psicológicas, com linguagem humana e aplicável.",
    "Não cite diagnóstico, não faça promessas de cura e não use linguagem excessivamente técnica.",
    "Responda apenas em JSON válido, sem markdown, com estas chaves:",
    'title, summary, objective, illustration, guided_questions, self_evaluation, closing_message',
    "",
    `Título da tarefa: ${title}`,
    `Descrição da tarefa: ${description}`,
    promptComplement
      ? `Complementos da profissional para a IA: ${promptComplement}`
      : "Complementos da profissional para a IA: nenhum",
    "",
    "Regras:",
    "- summary: uma frase curta explicando a proposta do material",
    "- objective: no máximo 1 frase curta e sucinta",
    '- illustration: objeto com scene_title, subject, support_label e accent_color (hex suave como #7C6CFF, #4F9D8F ou #F59E0B)',
    "- guided_questions: objeto com exatamente 3 perguntas curtas e variadas de acordo com o título e a descrição",
    "- guided_questions.observation: pergunta de observação coerente com o tema",
    "- guided_questions.action_reflection: pergunta de ação ou reflexão coerente com o tema",
    "- guided_questions.self_evaluation: pergunta de autoavaliação coerente com o tema e ligada ao recurso visual",
    '- self_evaluation: objeto com type ("emotion_faces", "emotion_scale" ou "emotion_bar"), title, prompt, anchors (array com 3 a 5 rótulos curtos) e notes_prompt',
    "- self_evaluation deve sempre sugerir uma régua de emojis/emoções e abrir espaço para a pessoa registrar impressões ou perguntas para levar à psicóloga",
    "- closing_message: um parágrafo curto de encerramento acolhedor"
  ].join("\n");
}

app.post("/api/ai/task-material-preview", async (req, res) => {
  const { title = "", description = "", promptComplement = "" } = req.body || {};

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
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
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
              promptComplement: promptComplement.trim()
            })
          }
        ]
      })
    });

    const payload = await response.json();

    if (!response.ok) {
      const apiError =
        payload?.error?.message || "A OpenAI não conseguiu gerar o material neste momento.";
      return res.status(502).json({ error: apiError });
    }

    const content = payload?.choices?.[0]?.message?.content?.trim();

    if (!content) {
      return res.status(502).json({
        error: "A IA não retornou conteúdo para esta tarefa."
      });
    }

    let material;

    try {
      material = JSON.parse(content);
    } catch (parseError) {
      material = {
        title: title.trim(),
        summary: "Prévia gerada pela IA.",
        raw_text: content
      };
    }

    return res.json({ material });
  } catch (error) {
    console.error("Erro ao gerar material com IA:", error);
    return res.status(500).json({
      error: "Não foi possível gerar o material com IA."
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

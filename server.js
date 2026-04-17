import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function perfilValido(perfil) {
  return ["paciente", "profissional"].includes(perfil);
}

app.get("/", (req, res) => {
  res.send("API PsicoTarefas rodando 🚀");
});

app.post("/register", async (req, res) => {
  const nome = req.body.nome?.trim();
  const email = req.body.email?.trim().toLowerCase();
  const password = req.body.password;
  const perfil = req.body.perfil?.trim().toLowerCase();

  if (!nome || !email || !password || !perfil) {
    return res.status(400).json({
      error: "Nome, e-mail, senha e perfil são obrigatórios."
    });
  }

  if (!perfilValido(perfil)) {
    return res.status(400).json({
      error: "Perfil inválido. Use 'paciente' ou 'profissional'."
    });
  }

  let createdUserId = null;

  try {
    const { data: authData, error: authError } =
      await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          nome,
          perfil
        }
      });

    if (authError) {
      const mensagem =
        authError.message?.toLowerCase().includes("already") ||
        authError.message?.toLowerCase().includes("registered")
          ? "E-mail já cadastrado."
          : authError.message;

      return res.status(400).json({
        error: mensagem || "Erro ao criar usuário no Auth."
      });
    }

    if (!authData?.user?.id) {
      return res.status(500).json({
        error: "Usuário criado sem ID válido no Auth."
      });
    }

    createdUserId = authData.user.id;

    const { error: perfilError } = await supabase.from("perfis").insert({
      user_id: createdUserId,
      nome,
      email,
      perfil
    });

    if (perfilError) {
      await supabase.auth.admin.deleteUser(createdUserId);

      const mensagem =
        perfilError.message?.toLowerCase().includes("duplicate") ||
        perfilError.message?.toLowerCase().includes("unique")
          ? "Já existe um perfil cadastrado com este e-mail."
          : perfilError.message;

      return res.status(400).json({
        error: mensagem || "Erro ao criar perfil do usuário."
      });
    }

    return res.status(201).json({
      success: true,
      user: {
        id: createdUserId,
        nome,
        email,
        perfil
      }
    });
  } catch (err) {
    if (createdUserId) {
      try {
        await supabase.auth.admin.deleteUser(createdUserId);
      } catch (rollbackError) {
        console.error("Erro ao desfazer criação do usuário:", rollbackError);
      }
    }

    console.error("Erro interno no /register:", err);

    return res.status(500).json({
      error: "Erro interno ao criar usuário."
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});


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

app.get("/", (req, res) => {
  res.send("API PsicoTarefas rodando 🚀");
});

app.post("/register", async (req, res) => {
  const { nome, email, password, perfil } = req.body;

  if (!nome || !email || !password || !perfil) {
    return res.status(400).json({
      error: "Nome, e-mail, senha e perfil são obrigatórios."
    });
  }

  try {
    const { data: usersData, error: usersError } = await supabase.auth.admin.listUsers();

    if (usersError) {
      return res.status(500).json({ error: usersError.message });
    }

    const exists = usersData.users.some(
      (user) => user.email?.toLowerCase() === email.toLowerCase()
    );

    if (exists) {
      return res.status(400).json({ error: "E-mail já cadastrado." });
    }

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        nome,
        perfil
      }
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.status(201).json({
      success: true,
      user: data.user
    });
  } catch (err) {
    return res.status(500).json({
      error: "Erro interno ao criar usuário."
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});


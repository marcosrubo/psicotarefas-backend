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

// TESTE
app.get("/", (req, res) => {
  res.send("API PsicoTarefas rodando 🚀");
});

// REGISTER
app.post("/register", async (req, res) => {
  const { email, password } = req.body;

  try {
    const { data: users } = await supabase.auth.admin.listUsers();

    const exists = users.users.find(u => u.email === email);

    if (exists) {
      return res.status(400).json({ error: "Email já cadastrado" });
    }

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true
    });

    if (error) throw error;

    res.json({ success: true, user: data.user });

  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(3000, () => {
  console.log("Servidor rodando na porta 3000");
});


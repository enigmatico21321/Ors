const express = require("express");
const multer  = require("multer");
const fs      = require("fs");
const path    = require("path");
const crypto  = require("crypto");

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── PATHS ───────────────────────────────────────────────
const DATA_FILE    = path.join(__dirname, "data.json");
const SCRIPTS_DIR  = path.join(__dirname, "scripts");
const PUBLIC_DIR   = path.join(__dirname, "public");

if (!fs.existsSync(SCRIPTS_DIR)) fs.mkdirSync(SCRIPTS_DIR);
if (!fs.existsSync(PUBLIC_DIR))  fs.mkdirSync(PUBLIC_DIR);

// ─── LOAD / SAVE DATA ────────────────────────────────────
function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const def = { adminPassword: "", webhookUrl: "", scripts: [] };
    fs.writeFileSync(DATA_FILE, JSON.stringify(def, null, 2));
    return def;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function saveData(d) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}

// ─── MULTER (file upload) ────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, SCRIPTS_DIR),
  filename:    (req, file, cb) => {
    const id  = crypto.randomBytes(8).toString("hex");
    const ext = path.extname(file.originalname) || ".lua";
    cb(null, id + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// ─── MIDDLEWARE ───────────────────────────────────────────
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// ─── AUTH MIDDLEWARE ──────────────────────────────────────
function adminAuth(req, res, next) {
  const d = loadData();
  if (!d.adminPassword) return next(); // sem senha = acesso livre
  const pass = req.headers["x-admin-password"] || req.query.pass;
  if (pass !== d.adminPassword) return res.status(401).json({ error: "Senha incorreta" });
  next();
}

// ════════════════════════════════════════════════════════
//  PUBLIC ROUTES
// ════════════════════════════════════════════════════════

// GET /api/scripts — lista pública (sem conteúdo)
app.get("/api/scripts", (req, res) => {
  const d = loadData();
  const pub = d.scripts.map(s => ({
    id:      s.id,
    name:    s.name,
    hits:    s.hits,
    active:  s.active,
    created: s.created
  }));
  res.json(pub);
});

// GET /s/:id — serve o script (loadstring endpoint)
app.get("/s/:id", async (req, res) => {
  const d = loadData();
  const script = d.scripts.find(s => s.id === req.params.id);

  if (!script)         return res.status(404).send("-- script not found");
  if (!script.active)  return res.status(403).send("-- script disabled");
  if (script.deleted)  return res.status(410).send("-- script deleted");

  // Bloqueia acesso direto pelo navegador
  const ua = req.headers["user-agent"] || "";
  if (!ua.includes("Roblox")) {
    return res.status(403).send("403 - Access Denied");
  }

  // increment hits
  script.hits = (script.hits || 0) + 1;
  script.log  = script.log || [];
  const entry = { n: script.hits, time: new Date().toLocaleString("pt-BR"), ip: req.ip };
  script.log.unshift(entry);
  if (script.log.length > 100) script.log = script.log.slice(0, 100);
  saveData(d);

  // send webhook
  if (d.webhookUrl) {
    fetch(d.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "OR'S HUB",
        embeds: [{
          title: "📥 Script Executado",
          description: `**${script.name}** foi executado`,
          color: 0xffffff,
          fields: [
            { name: "Acesso nº", value: `#${script.hits}`, inline: true },
            { name: "Horário",   value: entry.time,        inline: true }
          ],
          footer: { text: "OR'S HUB" }
        }]
      })
    }).catch(() => {});
  }

  // serve file
  const filePath = path.join(SCRIPTS_DIR, script.filename);
  if (!fs.existsSync(filePath)) return res.status(500).send("-- file missing");
  res.setHeader("Content-Type", "text/plain");
  res.send(fs.readFileSync(filePath, "utf8"));
});

// ════════════════════════════════════════════════════════
//  ADMIN ROUTES
// ════════════════════════════════════════════════════════

// GET /api/admin/scripts — lista com logs (requer senha)
app.get("/api/admin/scripts", adminAuth, (req, res) => {
  const d = loadData();
  res.json(d.scripts);
});

// POST /api/admin/upload — upload de script
app.post("/api/admin/upload", adminAuth, upload.single("file"), (req, res) => {
  const d = loadData();
  if (!req.file && !req.body.content) return res.status(400).json({ error: "Nenhum arquivo enviado" });

  let filename, originalName;

  if (req.file) {
    filename     = req.file.filename;
    originalName = req.file.originalname;
  } else {
    // pasted content
    const id = crypto.randomBytes(8).toString("hex");
    filename = id + ".lua";
    originalName = (req.body.name || "script") + ".lua";
    fs.writeFileSync(path.join(SCRIPTS_DIR, filename), req.body.content, "utf8");
  }

  const id = path.parse(filename).name;
  const script = {
    id,
    name:     req.body.name || path.parse(originalName).name,
    filename,
    hits:     0,
    active:   true,
    deleted:  false,
    created:  new Date().toLocaleString("pt-BR"),
    log:      []
  };

  d.scripts.push(script);
  saveData(d);

  res.json({ ok: true, id, loadstring: `/s/${id}` });
});

// PATCH /api/admin/scripts/:id — editar nome / ativar / desativar
app.patch("/api/admin/scripts/:id", adminAuth, (req, res) => {
  const d = loadData();
  const s = d.scripts.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: "Script não encontrado" });
  if (req.body.name   !== undefined) s.name   = req.body.name;
  if (req.body.active !== undefined) s.active = req.body.active;
  saveData(d);
  res.json({ ok: true });
});

// DELETE /api/admin/scripts/:id — deletar script
app.delete("/api/admin/scripts/:id", adminAuth, (req, res) => {
  const d = loadData();
  const idx = d.scripts.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Não encontrado" });
  const s = d.scripts[idx];
  // remove file
  const fp = path.join(SCRIPTS_DIR, s.filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  d.scripts.splice(idx, 1);
  saveData(d);
  res.json({ ok: true });
});

// DELETE /api/admin/scripts/:id/log — limpar log
app.delete("/api/admin/scripts/:id/log", adminAuth, (req, res) => {
  const d = loadData();
  const s = d.scripts.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: "Não encontrado" });
  s.log  = [];
  s.hits = 0;
  saveData(d);
  res.json({ ok: true });
});

// GET /api/admin/settings
app.get("/api/admin/settings", adminAuth, (req, res) => {
  const d = loadData();
  res.json({ webhookUrl: d.webhookUrl, adminPassword: d.adminPassword ? "***" : "" });
});

// POST /api/admin/settings
app.post("/api/admin/settings", adminAuth, (req, res) => {
  const d = loadData();
  if (req.body.webhookUrl    !== undefined) d.webhookUrl    = req.body.webhookUrl;
  if (req.body.adminPassword !== undefined && req.body.adminPassword !== "***")
    d.adminPassword = req.body.adminPassword;
  saveData(d);
  res.json({ ok: true });
});

// POST /api/admin/test-webhook
app.post("/api/admin/test-webhook", adminAuth, async (req, res) => {
  const url = req.body.url || loadData().webhookUrl;
  if (!url) return res.status(400).json({ error: "Sem URL" });
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "OR'S HUB",
        embeds: [{ title: "🔔 Teste de Webhook", description: "Funcionando!", color: 0xffffff, footer: { text: "OR'S HUB" } }]
      })
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: "Falhou: " + e.message }); }
});

// ─── START ────────────────────────────────────────────────
app.listen(PORT, () => console.log(`OR'S HUB rodando na porta ${PORT}`));

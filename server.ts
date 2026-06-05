import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";

const app = express();
const PORT = 3000;

interface StoreCache {
  name: string;
  description: string;
  logo: string;
  timestamp: number;
}

// Guarda as informações das lojas em cache por 5 minutos para otimizar acessos
const storeCache: Record<string, StoreCache> = {};
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

function escapeHtml(text: string): string {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Serve metadados dinâmicos para a loja quando compartilhado
app.get("/loja.html", async (req, res) => {
  const storeId = req.query.id;
  const isProd = process.env.NODE_ENV === "production";
  const filePath = isProd 
    ? path.join(process.cwd(), "dist", "loja.html")
    : path.join(process.cwd(), "loja.html");

  if (!storeId || typeof storeId !== "string") {
    if (fs.existsSync(filePath)) {
      return res.sendFile(filePath);
    }
    return res.status(404).send("Loja não encontrada");
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Template da loja não encontrado");
  }

  try {
    let storeInfo = storeCache[storeId];
    const now = Date.now();

    if (!storeInfo || now - storeInfo.timestamp > CACHE_TTL) {
      // Busca as informações diretamente do banco de dados Firestore REST API
      const url = `https://firestore.googleapis.com/v1/projects/gen-lang-client-0664324166/databases/ai-studio-2395f72f-4dac-4517-9681-c654cd1a03ca/documents/stores/${encodeURIComponent(storeId)}?key=AIzaSyAJaxRdA6uzbN41JvAw8xO7F5mzJaDfMBc`;
      
      const firestoreRes = await fetch(url);
      if (firestoreRes.ok) {
        const docData = await firestoreRes.json();
        const fields = docData.fields || {};
        
        const storeName = fields.n?.stringValue || "Catálogo Virtual";
        const storeType = fields.t?.stringValue || "Crie seu catálogo profissional, loja online e presença digital completa.";
        const storeLogo = fields.lg?.stringValue || "https://images.unsplash.com/photo-1549298916-b41d501d3772?auto=format&fit=crop&q=80&w=200";

        storeInfo = {
          name: storeName,
          description: storeType,
          logo: storeLogo,
          timestamp: now
        };
        storeCache[storeId] = storeInfo;
      }
    }

    let htmlContent = await fs.promises.readFile(filePath, "utf-8");

    if (storeInfo) {
      const escapedName = escapeHtml(storeInfo.name);
      const escapedDesc = escapeHtml(storeInfo.description);
      const escapedLogo = escapeHtml(storeInfo.logo);

      // Preenche os metadados do HTML em tempo de execução para as redes sociais (WhatsApp, Insta, etc) lerem
      const replacement = `
    <title>${escapedName} | CatálogoZap</title>
    <meta name="description" content="${escapedDesc}">
    <link rel="icon" type="image/png" href="${escapedLogo}">
    <meta property="og:title" content="${escapedName}">
    <meta property="og:description" content="${escapedDesc}">
    <meta property="og:image" content="${escapedLogo}">
    <meta property="og:type" content="website">
    <meta property="og:url" content="https://acheaqui.net.br/loja.html?id=${encodeURIComponent(storeId)}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapedName}">
    <meta name="twitter:description" content="${escapedDesc}">
    <meta name="twitter:image" content="${escapedLogo}">
      `;

      htmlContent = htmlContent.replace("<title>Carregando Catálogo...</title>", replacement);
    }

    res.setHeader("Content-Type", "text/html");
    return res.send(htmlContent);
  } catch (err) {
    console.error("Erro gerando tags dinâmicas para", storeId, err);
    return res.sendFile(filePath);
  }
});

async function bootstrap() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

bootstrap();

import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "10mb" }));

// Lazy Google GenAI Client
let genAIClient: GoogleGenAI | null = null;
function getGenAI(): GoogleGenAI | null {
  if (!genAIClient && process.env.GEMINI_API_KEY) {
    genAIClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return genAIClient;
}

// API endpoint for Virtual Attendant (AI)
app.post("/api/ai-chat", async (req, res) => {
  try {
    const { message, storeContext, chatHistory } = req.body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Mensagem inválida" });
    }

    const ai = getGenAI();
    if (!ai) {
      return res.status(503).json({ 
        error: "Chave Gemini não configurada no servidor",
        fallback: true 
      });
    }

    const storeName = storeContext?.name || "Nossa Loja";
    const storeType = storeContext?.type || "Comércio / Serviços";
    const storeBio = storeContext?.bio || storeContext?.description || "";
    const storeCity = storeContext?.city || "";
    const storeAddress = storeContext?.address || "";
    const storePhone = storeContext?.phone || storeContext?.whatsapp || "";
    const paymentMethods = storeContext?.paymentMethods || "PIX, Cartão e Dinheiro";
    const deliveryInfo = storeContext?.deliveryInfo || "Entrega local e retirada";
    const productsList = (storeContext?.products || [])
      .slice(0, 80)
      .map((p: any) => `- ${p.name}: R$ ${p.price || 0}${p.description ? ` (${p.description})` : ""}${p.category ? ` [Categoria: ${p.category}]` : ""}`)
      .join("\n");

    const systemInstruction = `Você é a Atendente Virtual Oficial e Inteligente da empresa "${storeName}".
Segmento / Especialidade: "${storeType}".
${storeBio ? `Sobre a empresa: ${storeBio}` : ""}
${storeCity ? `Cidade / Localização: ${storeCity} ${storeAddress}` : ""}
Contato WhatsApp: ${storePhone}
Formas de Pagamento: ${paymentMethods}
Informações de Frete / Atendimento: ${deliveryInfo}

PRODUTOS E SERVIÇOS DISPONÍVEIS NO CATÁLOGO:
${productsList || "Nenhum produto cadastrado no momento."}

DIRETRIZES FUNDAMENTAIS DE ATENDIMENTO:
1. Responda em português brasileiro de maneira prestativa, profissional, calorosa e concisa (máximo 2 a 3 frases por resposta).
2. Se o cliente perguntar se a empresa faz ou vende algo que NÃO está na lista de produtos/serviços nem pertence ao segmento da empresa (por exemplo, perguntar se levanta muro para uma loja de pisos industriais, ou se vende pizza para uma hamburgueria):
   - NUNCA diga respostas genéricas como "Não sei informar" ou "Ainda não tenho essa informação".
   - Explique educadamente o foco exato da empresa e esclareça que não trabalham com esse outro item.
   - Exemplo modelo: "A ${storeName} é especializada em ${storeType} (como ${productsList.split("\n")[0] || "nossos serviços de catálogo"}). Não realizamos [serviço solicitado]. Gostaria de um orçamento para nossos serviços de [área da empresa] ou falar com a equipe no WhatsApp?"
3. Se o cliente perguntar sobre produtos existentes, preços, agendamentos, pagamentos ou prazos, responda com precisão baseado nos dados acima.
4. Se o cliente pedir para falar com atendente humano ou negociar, oriente a clicar no botão de WhatsApp.
5. Seja natural, simpática e focada em ajudar a fechar negócios.`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [{ text: `${systemInstruction}\n\nPergunta do cliente: "${message}"` }]
        }
      ]
    });

    const replyText = response.text || "Olá! Como posso ajudar você hoje?";
    return res.json({ reply: replyText });
  } catch (error: any) {
    console.error("Erro no /api/ai-chat:", error);
    return res.status(500).json({ 
      error: error?.message || "Erro ao processar IA",
      fallback: true 
    });
  }
});

interface StoreCache {
  name: string;
  description: string;
  logo: string;
  timestamp: number;
}

// Cache to store shop details for 5 minutes, protecting project quotas in Firestore
const storeCache: Record<string, StoreCache> = {};
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function escapeHtml(text: string): string {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Serve Dynamic Metadata for tienda/store shares
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
      // Query Firestore REST API directly using our specific project and database credentials
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

      // Create high-fidelity og:tags and metadata block
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
    console.error("Error generating dynamic tags for ", storeId, err);
    return res.sendFile(filePath);
  }
});

async function bootstrap() {
  // Vite integration for development environment
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

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

// Endpoint for Shipping / Freight Calculation (Melhor Envio API)
app.post("/api/shipping/calculate", async (req, res) => {
  try {
    const { fromCep, toCep, products, token, extraDays, additionalValue, sandbox } = req.body;

    const cleanFrom = String(fromCep || "").replace(/\D/g, "");
    const cleanTo = String(toCep || "").replace(/\D/g, "");

    if (cleanFrom.length !== 8) {
      return res.status(400).json({ error: "CEP de origem inválido. Deve conter 8 dígitos." });
    }
    if (cleanTo.length !== 8) {
      return res.status(400).json({ error: "CEP de destino inválido. Deve conter 8 dígitos." });
    }

    const authToken = (token && typeof token === "string" && token.trim()) 
      ? token.trim() 
      : (process.env.MELHOR_ENVIO_TOKEN || "").trim();

    const isSandbox = !!sandbox || process.env.MELHOR_ENVIO_SANDBOX === "true";
    const baseUrl = isSandbox 
      ? "https://sandbox.melhorenvio.com.br/api/v2/me/shipment/calculate"
      : "https://melhorenvio.com.br/api/v2/me/shipment/calculate";

    // Build package items payload for Melhor Envio
    let itemsPayload: any[] = [];
    if (Array.isArray(products) && products.length > 0) {
      itemsPayload = products.map((p: any, idx: number) => {
        const qty = Math.max(1, parseInt(p.quantity || p.q || 1, 10));
        const priceNum = parseFloat(String(p.price || p.p || 10).replace(",", ".")) || 10;
        const widthNum = parseFloat(p.width || p.w || 15);
        const heightNum = parseFloat(p.height || p.h || 10);
        const lengthNum = parseFloat(p.length || p.l || 20);
        const weightNum = parseFloat(p.weight || p.peso || 0.3);

        return {
          id: String(p.id || `item_${idx + 1}`),
          width: Math.max(11, Math.min(100, widthNum)),
          height: Math.max(2, Math.min(100, heightNum)),
          length: Math.max(16, Math.min(100, lengthNum)),
          weight: Math.max(0.1, weightNum),
          insurance_value: Math.max(1, priceNum),
          quantity: qty
        };
      });
    } else {
      // Default standard e-commerce small box
      itemsPayload = [{
        id: "default_package",
        width: 16,
        height: 11,
        length: 16,
        weight: 0.5,
        insurance_value: 50.0,
        quantity: 1
      }];
    }

    const requestPayload = {
      from: { postal_code: cleanFrom },
      to: { postal_code: cleanTo },
      products: itemsPayload
    };

    if (authToken) {
      try {
        const meRes = await fetch(baseUrl, {
          method: "POST",
          headers: {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": `Bearer ${authToken}`,
            "User-Agent": "CatalogoZap (suporte@catalogozap.com)"
          },
          body: JSON.stringify(requestPayload)
        });

        if (meRes.ok) {
          const meData = await meRes.json();
          if (Array.isArray(meData)) {
            const addedDays = parseInt(String(extraDays || 0), 10) || 0;
            const extraVal = parseFloat(String(additionalValue || 0).replace(",", ".")) || 0;

            const options = meData
              .filter((opt: any) => !opt.error && opt.price && parseFloat(opt.price) > 0)
              .map((opt: any) => {
                const basePrice = parseFloat(opt.custom_price || opt.price || 0);
                const finalPrice = Math.round((basePrice + extraVal) * 100) / 100;
                const minDays = (opt.custom_delivery_range?.min || opt.delivery_range?.min || opt.custom_delivery_time || opt.delivery_time || 2) + addedDays;
                const maxDays = (opt.custom_delivery_range?.max || opt.delivery_range?.max || opt.custom_delivery_time || opt.delivery_time || 5) + addedDays;
                
                return {
                  id: opt.id,
                  name: `${opt.company?.name || "Transportadora"} (${opt.name})`,
                  service: opt.name,
                  company: opt.company?.name || "Transportadora",
                  companyLogo: opt.company?.picture || "",
                  price: finalPrice,
                  originalPrice: basePrice,
                  currency: opt.currency || "R$",
                  deliveryMinDays: minDays,
                  deliveryMaxDays: maxDays,
                  deliveryDaysText: minDays === maxDays 
                    ? `${minDays} ${minDays === 1 ? 'dia útil' : 'dias úteis'}`
                    : `${minDays} a ${maxDays} dias úteis`
                };
              });

            if (options.length > 0) {
              return res.json({
                success: true,
                fromCep: cleanFrom,
                toCep: cleanTo,
                options
              });
            }
          }
        } else {
          const errText = await meRes.text();
          console.warn("Melhor Envio returned error:", meRes.status, errText);
        }
      } catch (meError: any) {
        console.warn("Error requesting Melhor Envio API:", meError.message);
      }
    }

    // Fallback: Realistic Estimation based on CEP distance (Region matching)
    // Ensures customers always get a functional shipping quote even if token is pending
    const fromPrefix = parseInt(cleanFrom.substring(0, 2), 10);
    const toPrefix = parseInt(cleanTo.substring(0, 2), 10);
    const isSameRegion = Math.abs(fromPrefix - toPrefix) <= 5;
    const isSameState = cleanFrom.charAt(0) === cleanTo.charAt(0);

    const pacBase = isSameRegion ? 18.90 : (isSameState ? 24.50 : 34.90);
    const sedexBase = isSameRegion ? 26.50 : (isSameState ? 39.90 : 58.90);
    const jadlogBase = isSameRegion ? 17.50 : (isSameState ? 22.90 : 31.90);

    const addedDays = parseInt(String(extraDays || 0), 10) || 0;
    const extraVal = parseFloat(String(additionalValue || 0).replace(",", ".")) || 0;

    const fallbackOptions = [
      {
        id: "pac_estimate",
        name: "Correios (PAC)",
        service: "PAC",
        company: "Correios",
        companyLogo: "https://assets.melhorenvio.com.br/companies/correios.png",
        price: Math.round((pacBase + extraVal) * 100) / 100,
        currency: "R$",
        deliveryMinDays: (isSameRegion ? 3 : (isSameState ? 5 : 7)) + addedDays,
        deliveryMaxDays: (isSameRegion ? 5 : (isSameState ? 8 : 12)) + addedDays,
        deliveryDaysText: `${(isSameRegion ? 3 : (isSameState ? 5 : 7)) + addedDays} a ${(isSameRegion ? 5 : (isSameState ? 8 : 12)) + addedDays} dias úteis`
      },
      {
        id: "sedex_estimate",
        name: "Correios (SEDEX Express)",
        service: "SEDEX",
        company: "Correios",
        companyLogo: "https://assets.melhorenvio.com.br/companies/correios.png",
        price: Math.round((sedexBase + extraVal) * 100) / 100,
        currency: "R$",
        deliveryMinDays: (isSameRegion ? 1 : (isSameState ? 2 : 3)) + addedDays,
        deliveryMaxDays: (isSameRegion ? 2 : (isSameState ? 3 : 5)) + addedDays,
        deliveryDaysText: `${(isSameRegion ? 1 : (isSameState ? 2 : 3)) + addedDays} a ${(isSameRegion ? 2 : (isSameState ? 3 : 5)) + addedDays} dias úteis`
      },
      {
        id: "jadlog_estimate",
        name: "Jadlog (.Package)",
        service: ".Package",
        company: "Jadlog",
        companyLogo: "https://assets.melhorenvio.com.br/companies/jadlog.png",
        price: Math.round((jadlogBase + extraVal) * 100) / 100,
        currency: "R$",
        deliveryMinDays: (isSameRegion ? 2 : (isSameState ? 4 : 6)) + addedDays,
        deliveryMaxDays: (isSameRegion ? 4 : (isSameState ? 7 : 10)) + addedDays,
        deliveryDaysText: `${(isSameRegion ? 2 : (isSameState ? 4 : 6)) + addedDays} a ${(isSameRegion ? 4 : (isSameState ? 7 : 10)) + addedDays} dias úteis`
      }
    ];

    return res.json({
      success: true,
      fromCep: cleanFrom,
      toCep: cleanTo,
      isEstimate: !authToken,
      options: fallbackOptions
    });
  } catch (err: any) {
    console.error("Erro no /api/shipping/calculate:", err);
    return res.status(500).json({ error: "Erro ao calcular frete: " + (err.message || err) });
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

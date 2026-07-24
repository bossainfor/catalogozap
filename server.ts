import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

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

// Endpoint para Importar / Extrair Catálogo Externo (Anota AI, Goomer, Cardápio Web, etc)
app.post("/api/import-catalog", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "URL do catálogo não informada." });
    }

    let targetUrl = url.trim();
    if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
      targetUrl = "https://" + targetUrl;
    }

    console.log(`[ImportCatalog] Tentando extrair de: ${targetUrl}`);

    const fetchHtml = async (fetchUrl: string) => {
      try {
        const response = await fetch(fetchUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8",
            "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
          }
        });
        if (!response.ok) return null;
        return await response.text();
      } catch (e) {
        return null;
      }
    };

    let htmlOrJson = await fetchHtml(targetUrl);

    // Se direct fetch falhou ou caiu no Cloudflare
    const isCloudflare = !htmlOrJson || htmlOrJson.includes("Cloudflare") || htmlOrJson.includes("Attention Required!") || htmlOrJson.includes("cf-browser-verification");

    if (isCloudflare) {
      console.log(`[ImportCatalog] Direct fetch bloqueado por Cloudflare em ${targetUrl}. Tentando proxies...`);
      // Tenta via proxy public
      const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`;
      const proxyHtml = await fetchHtml(proxyUrl);
      if (proxyHtml && !proxyHtml.includes("Cloudflare") && !proxyHtml.includes("Attention Required!")) {
        htmlOrJson = proxyHtml;
      }
    }

    let extractedProducts: Array<{
      name: string;
      price: string | number;
      description?: string;
      category?: string;
      image?: string;
    }> = [];

    // Estratégia 1: Anota AI API
    if (targetUrl.includes("anota.ai") || (htmlOrJson && (htmlOrJson.includes("anota.ai") || htmlOrJson.includes("Anota AI")))) {
      const cleanParts = targetUrl.split("?")[0].split("/").filter(Boolean);
      let slug = cleanParts[cleanParts.length - 1];
      if (slug === "loja" && cleanParts.length > 1) {
        slug = cleanParts[cleanParts.length - 1];
      }
      
      if (slug && slug !== "anota.ai" && slug !== "menu.anota.ai" && slug !== "pedindo.anota.ai" && slug !== "pedido.anota.ai" && slug !== "loja") {
        const anotaEndpoints = [
          `https://api-cdn.anota.ai/v2/catalog/${slug}`,
          `https://api.anota.ai/v2/catalog/${slug}`,
          `https://api.anota.ai/v1/store/${slug}`
        ];

        for (const apiUrl of anotaEndpoints) {
          try {
            console.log(`[ImportCatalog] Buscando API Anota AI: ${apiUrl}`);
            const apiRes = await fetch(apiUrl, {
              headers: { 
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                "Accept": "application/json, text/plain, */*",
                "Origin": "https://pedido.anota.ai",
                "Referer": "https://pedido.anota.ai/"
              }
            });

            if (apiRes.ok) {
              const apiData = await apiRes.json();
              const categories = apiData?.data?.categories || apiData?.data?.catalog || apiData?.categories || (Array.isArray(apiData?.data) ? apiData.data : []);
              if (Array.isArray(categories)) {
                for (const cat of categories) {
                  const catName = cat.title || cat.name || "Geral";
                  const items = cat.items || cat.products || [];
                  for (const item of items) {
                    if (item.title || item.name) {
                      extractedProducts.push({
                        name: item.title || item.name || "",
                        price: item.price || item.value || (item.prices && item.prices[0] ? item.prices[0].price : ""),
                        description: item.description || item.details || "",
                        category: catName,
                        image: item.image || item.photo || item.avatar || (item.images && item.images[0]) || ""
                      });
                    }
                  }
                }
              }
              if (extractedProducts.length > 0) break;
            }
          } catch (e) {
            console.warn("[ImportCatalog] Erro na API do Anota AI:", e);
          }
        }
      }
    }

    // Estratégia 2: Gemini AI para parsing inteligente de HTML/Texto se obtivemos HTML válido
    if (extractedProducts.length === 0 && htmlOrJson && !htmlOrJson.includes("Attention Required!") && process.env.GEMINI_API_KEY) {
      try {
        const { GoogleGenAI } = await import("@google/genai");
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        
        const cleanedHtml = htmlOrJson
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<svg[\s\S]*?<\/svg>/gi, "")
          .substring(0, 80000);

        const prompt = `Extraia todos os produtos/itens do cardápio/catálogo contidos no texto HTML abaixo.
Instrução estrita: Retorne APENAS um array JSON de objetos válidos sem marcações markdown fora do JSON.
Schema:
[
  {
    "name": "Nome do Produto",
    "price": "25,00",
    "description": "Descrição do item se houver",
    "category": "Nome da Categoria",
    "image": "https://link-da-imagem.jpg"
  }
]

HTML do site:
${cleanedHtml}`;

        const aiRes = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: prompt,
        });

        const text = aiRes.text || "";
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (Array.isArray(parsed) && parsed.length > 0) {
            extractedProducts = parsed;
          }
        }
      } catch (e) {
        console.error("[ImportCatalog] Erro na IA Gemini:", e);
      }
    }

    // Tratar e formatar produtos
    const finalProducts = extractedProducts
      .filter(p => p.name && p.name.trim().length > 1)
      .map((p, idx) => {
        let rawPrice = String(p.price || "").replace("R$", "").trim();
        if (!isNaN(Number(rawPrice)) && rawPrice !== "") {
          rawPrice = Number(rawPrice).toFixed(2).replace(".", ",");
        }
        return {
          id: String(Date.now() + idx + Math.floor(Math.random() * 10000)),
          name: p.name.trim(),
          price: rawPrice,
          description: (p.description || "").trim(),
          category: (p.category || "Geral").trim(),
          image: p.image || "",
          available: true,
          f: false,
          vars: "",
          wholesalePrice: "",
          wholesaleMinQty: ""
        };
      });

    console.log(`[ImportCatalog] Total de produtos extraídos: ${finalProducts.length}`);

    if (finalProducts.length === 0 && isCloudflare) {
      return res.status(200).json({
        success: false,
        cloudflareBlocked: true,
        error: "Este site utiliza proteção da Cloudflare que impede a leitura direta por link. Por favor, utilize a aba 'Copiar e Colar Texto/HTML' para colar o texto do cardápio e a Inteligência Artificial extrairá tudo instantaneamente!"
      });
    }

    return res.json({
      success: true,
      count: finalProducts.length,
      products: finalProducts
    });

  } catch (err: any) {
    console.error("[ImportCatalog] Erro inesperado:", err);
    return res.status(500).json({ success: false, error: "Erro interno ao processar a importação: " + (err?.message || err) });
  }
});

// Endpoint para Importar / Extrair Catálogo via Texto Colado com IA Gemini
app.post("/api/parse-pasted-catalog", async (req, res) => {
  try {
    const { content } = req.body;
    if (!content || typeof content !== "string" || content.trim().length < 5) {
      return res.status(400).json({ success: false, error: "Cole o texto ou HTML do seu cardápio antes de extrair." });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ success: false, error: "Chave Gemini de IA não configurada no servidor." });
    }

    console.log(`[ParsePastedCatalog] Processando texto colado com tamanho: ${content.length} caracteres`);

    let parsed: any[] | null = null;

    // Se o conteúdo já for um JSON válido de produtos (ex: copiado pelo Marcador)
    const trimmed = content.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const directJson = JSON.parse(trimmed);
        if (Array.isArray(directJson) && directJson.length > 0 && directJson[0].name) {
          console.log(`[ParsePastedCatalog] Detectado JSON direto do Marcador com ${directJson.length} itens!`);
          parsed = directJson;
        }
      } catch (e) {
        // Não é JSON puro, prossegue para IA Gemini
      }
    }

    if (!parsed) {
      if (!process.env.GEMINI_API_KEY) {
        return res.status(500).json({ success: false, error: "Chave Gemini de IA não configurada no servidor." });
      }

      const { GoogleGenAI } = await import("@google/genai");
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

      const prompt = `Analise o texto ou código HTML de cardápio/catálogo de loja colado abaixo e extraia TODOS os produtos/itens legítimos com seus nomes, preços, descrições, categorias e URLs de imagens (se houver).

Regras de Filtragem Importantes:
1. DESCARTE botões e textos de interface como "Início", "Carrinho", "Observações", "20%", "10%", "Pedido Mínimo", "Aberto até", "Ver Detalhes", "Adicionar".
2. Agrupe os produtos por suas respectivas categorias (ex: "Bebidas", "Churrasco", "Pizzas", "Destaques").
3. O preço deve ser apenas o número no formato com vírgula (ex: "6,90", "23,90").
4. Se houver links de imagens (URLs http/https), inclua no campo "image".

Instrução estrita: Retorne APENAS um array JSON com os objetos encontrados, sem qualquer texto adicional ou blocos de código além do JSON.

Exemplo de saída esperada:
[
  {
    "name": "Coca-Cola 2 Litros",
    "price": "12,00",
    "description": "Gelada 2L pet",
    "category": "Bebidas",
    "image": "https://cdn.exemplo.com/coca.jpg"
  },
  {
    "name": "Cerveja Spaten Puro Malte 350ml",
    "price": "6,90",
    "description": "Lata 350ml gelada",
    "category": "Bebidas",
    "image": ""
  }
]

Conteúdo do Cardápio:
${content.substring(0, 100000)}`;

      let aiRes;
      try {
        aiRes = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: prompt,
        });
      } catch (geminiErr: any) {
        console.warn("[ParsePastedCatalog] gemini-2.5-flash falhou, tentando gemini-1.5-flash...", geminiErr?.message);
        aiRes = await ai.models.generateContent({
          model: "gemini-1.5-flash",
          contents: prompt,
        });
      }

      const text = aiRes.text || "";
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        return res.status(400).json({ success: false, error: "Não foi possível reconhecer produtos no texto colado. Verifique se copiou nomes e valores do cardápio." });
      }

      parsed = JSON.parse(jsonMatch[0]);
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      return res.status(400).json({ success: false, error: "Nenhum produto foi detectado no texto fornecido." });
    }

    const finalProducts = parsed
      .filter((p: any) => p.name && String(p.name).trim().length > 1)
      .map((p: any, idx: number) => {
        let rawPrice = String(p.price || "").replace("R$", "").trim();
        if (!isNaN(Number(rawPrice)) && rawPrice !== "") {
          rawPrice = Number(rawPrice).toFixed(2).replace(".", ",");
        }
        return {
          id: String(Date.now() + idx + Math.floor(Math.random() * 10000)),
          name: String(p.name).trim(),
          price: rawPrice,
          description: (p.description || "").trim(),
          category: (p.category || "Geral").trim(),
          image: p.image || "",
          available: true,
          f: false,
          vars: "",
          wholesalePrice: "",
          wholesaleMinQty: ""
        };
      });

    return res.json({
      success: true,
      count: finalProducts.length,
      products: finalProducts
    });

  } catch (err: any) {
    console.error("[ParsePastedCatalog] Erro:", err);
    return res.status(500).json({ success: false, error: "Erro ao analisar o texto com IA: " + (err?.message || err) });
  }
});

// Middleware de tratamento de erros global para rotas de API (garante resposta JSON sempre)
app.use("/api", (err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("[API Error Middleware]:", err);
  res.status(err.status || 500).json({
    success: false,
    error: err.message || "Erro no servidor ao processar a requisição de API."
  });
});

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

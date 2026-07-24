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

    const response = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
      }
    });

    if (!response.ok) {
      return res.status(400).json({ error: `Não foi possível acessar a URL informada. Status HTTP: ${response.status}` });
    }

    const htmlOrJson = await response.text();
    let extractedProducts: Array<{
      name: string;
      price: string | number;
      description?: string;
      category?: string;
      image?: string;
    }> = [];

    // Estratégia 1: Anota AI API direta
    if (targetUrl.includes("anota.ai") || htmlOrJson.includes("anota.ai") || htmlOrJson.includes("Anota AI")) {
      const cleanParts = targetUrl.split("?")[0].split("/").filter(Boolean);
      const slug = cleanParts[cleanParts.length - 1];
      if (slug && slug !== "anota.ai" && slug !== "menu.anota.ai" && slug !== "pedindo.anota.ai" && slug !== "loja") {
        const anotaEndpoints = [
          `https://api-cdn.anota.ai/v2/catalog/${slug}`,
          `https://api.anota.ai/v2/catalog/${slug}`,
          `https://api.anota.ai/v1/store/${slug}`,
          `https://api.anota.ai/v1/catalog/slug/${slug}`,
          `https://api-cdn.anota.ai/v1/menu/${slug}`
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

    // Estratégia 1.5: JSON-LD (Schema.org / Menu / ItemList)
    if (extractedProducts.length === 0) {
      try {
        const ldMatches = htmlOrJson.matchAll(/<script\s+type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/gi);
        for (const match of ldMatches) {
          if (match[1]) {
            const ldData = JSON.parse(match[1]);
            const items = Array.isArray(ldData) ? ldData : [ldData];
            for (const item of items) {
              if (item['@type'] === 'Menu' || item['@type'] === 'ItemList' || item['@type'] === 'Restaurant') {
                const elements = item.hasMenuItem || item.itemListElement || item.hasMenuSection || item.menu || [];
                for (const el of elements) {
                  if (el.hasMenuItem) {
                    for (const mi of el.hasMenuItem) {
                      extractedProducts.push({
                        name: mi.name || "",
                        price: mi.offers?.price || mi.price || "",
                        description: mi.description || "",
                        category: el.name || "Geral",
                        image: mi.image || ""
                      });
                    }
                  } else if (el['@type'] === 'MenuItem' || el['@type'] === 'Product') {
                    extractedProducts.push({
                      name: el.name || "",
                      price: el.offers?.price || el.price || "",
                      description: el.description || "",
                      category: item.name || "Geral",
                      image: el.image || ""
                    });
                  }
                }
              }
            }
          }
        }
      } catch (e) {
        console.warn("[ImportCatalog] Erro no JSON-LD:", e);
      }
    }

    // Estratégia 2: Extracao de __NEXT_DATA__ ou window.__INITIAL_STATE__
    if (extractedProducts.length === 0) {
      try {
        const match = htmlOrJson.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
        if (match && match[1]) {
          const nextData = JSON.parse(match[1]);
          const pageProps = nextData?.props?.pageProps;
          if (pageProps) {
            const catalog = pageProps.catalog || pageProps.menu || pageProps.categories || pageProps.initialData || pageProps.storeData?.catalog;
            if (Array.isArray(catalog)) {
              for (const cat of catalog) {
                const catName = cat.name || cat.title || cat.category || "Geral";
                const items = cat.items || cat.products || cat.dishes || [];
                for (const item of items) {
                  extractedProducts.push({
                    name: item.name || item.title || "",
                    price: item.price || item.unitPrice || item.value || "",
                    description: item.description || item.details || "",
                    category: catName,
                    image: item.image || item.imageUrl || item.photo || item.url || ""
                  });
                }
              }
            }
          }
        }
      } catch (e) {
        console.warn("[ImportCatalog] Erro ao analisar __NEXT_DATA__:", e);
      }
    }

    // Estratégia 3: Gemini AI para parsing inteligente de HTML
    if (extractedProducts.length === 0 && process.env.GEMINI_API_KEY) {
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

    // Estratégia 4: Parser Heurístico Regex de Linhas de Preço
    if (extractedProducts.length === 0) {
      const priceRegex = /(?:R\$\s*)?(\d{1,4}[.,]\d{2})/g;
      const lines = htmlOrJson
        .replace(/<[^>]+>/g, "\n")
        .split("\n")
        .map(l => l.trim())
        .filter(Boolean);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (priceRegex.test(line) && line.length < 100) {
          const match = line.match(/(?:R\$\s*)?(\d{1,4}[.,]\d{2})/);
          if (match) {
            const priceVal = match[1];
            let name = line.replace(/(?:R\$\s*)?(\d{1,4}[.,]\d{2})/, "").trim();
            if (!name && i > 0) name = lines[i - 1];
            if (name && name.length > 2 && name.length < 80 && !name.toLowerCase().includes("subtotal")) {
              extractedProducts.push({
                name: name,
                price: priceVal,
                description: (lines[i + 1] && lines[i + 1].length > 8 && lines[i + 1].length < 180) ? lines[i + 1] : "",
                category: "Produtos Importados",
                image: ""
              });
            }
          }
        }
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

    return res.json({
      success: true,
      count: finalProducts.length,
      products: finalProducts
    });

  } catch (err: any) {
    console.error("[ImportCatalog] Erro inesperado:", err);
    return res.status(500).json({ error: "Erro interno ao processar a importação: " + (err?.message || err) });
  }
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

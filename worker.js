import CryptoJS from "crypto-js";

const M440_KEY = "X^Ib1O*HLVh%3W2t";
const chapterCache = new Map();

const CryptoJSAesJson = {
  stringify(cipherParams) {
    const value = {
      ct: cipherParams.ciphertext.toString(CryptoJS.enc.Base64),
    };

    if (cipherParams.iv) {
      value.iv = cipherParams.iv.toString();
    }

    if (cipherParams.salt) {
      value.s = cipherParams.salt.toString();
    }

    return JSON.stringify(value);
  },

  parse(jsonText) {
    const value = JSON.parse(jsonText);

    const cipherParams = CryptoJS.lib.CipherParams.create({
      ciphertext: CryptoJS.enc.Base64.parse(value.ct),
    });

    if (value.iv) {
      cipherParams.iv = CryptoJS.enc.Hex.parse(value.iv);
    }

    if (value.s) {
      cipherParams.salt = CryptoJS.enc.Hex.parse(value.s);
    }

    return cipherParams;
  },
};

function send(
  body,
  status = 200,
  contentType = "text/plain; charset=utf-8"
) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control":
        status === 200 ? "public, max-age=300" : "no-store",
    },
  });
}

function decryptChapters(rawBody) {
  let encrypted = rawBody.trim();

  if (!encrypted) {
    throw new Error("No se recibio la informacion cifrada");
  }

  if (encrypted.startsWith('"')) {
    encrypted = JSON.parse(encrypted);
  }

  const cached = chapterCache.get(encrypted);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const bytes = CryptoJS.AES.decrypt(encrypted, M440_KEY, {
    format: CryptoJSAesJson,
  });

  const decrypted = bytes.toString(CryptoJS.enc.Utf8);

  if (!decrypted) {
    throw new Error("No se pudo descifrar la lista de capitulos");
  }

  let chapters = JSON.parse(decrypted);

  if (typeof chapters === "string") {
    chapters = JSON.parse(chapters);
  }

  if (!Array.isArray(chapters)) {
    throw new Error("La lista descifrada no es valida");
  }

  chapterCache.set(encrypted, {
    value: chapters,
    expiresAt: Date.now() + 30 * 60 * 1000,
  });

  return chapters;
}

async function serveStatic(request, env) {
  const assetResponse = await env.ASSETS.fetch(request);
  const headers = new Headers(assetResponse.headers);

  headers.set("Access-Control-Allow-Origin", "*");

  return new Response(assetResponse.body, {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
            "Access-Control-Allow-Headers": "*",
          },
        });
      }

      if (url.pathname === "/health") {
        return send("YRepo M440 Cloudflare OK");
      }

      if (url.pathname === "/m440/chapters") {
        if (request.method !== "POST") {
          return send("Este endpoint requiere POST", 405);
        }

        const rawBody = await request.text();
        const size = new TextEncoder().encode(rawBody).byteLength;

        if (size > 2000000) {
          throw new Error(
            "La informacion cifrada es demasiado grande"
          );
        }

        const chapters = decryptChapters(rawBody);

        return send(
          JSON.stringify(chapters),
          200,
          "application/json; charset=utf-8"
        );
      }

      if (url.pathname === "/") {
        return send(
          `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>YRepo M440</title>
<style>
body {
  font-family: system-ui;
  margin: 40px;
  max-width: 760px;
  line-height: 1.5;
}
code {
  background: #f2f2f2;
  padding: 4px 7px;
  border-radius: 6px;
  word-break: break-all;
}
</style>
</head>
<body>
<h1>YRepo M440 activo</h1>
<p>Descifrador de capitulos: <strong>activo</strong>.</p>
<p>M440 se consulta directamente desde Aidoku.</p>
<p>Lista de Aidoku:</p>
<p><code>${url.origin}/index.min.json</code></p>
</body>
</html>`,
          200,
          "text/html; charset=utf-8"
        );
      }

      return await serveStatic(request, env);
    } catch (error) {
      console.error(error);

      const message =
        error instanceof Error ? error.message : String(error);

      return send(`Error: ${message}`, 500);
    }
  },
};

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const CryptoJS = require("crypto-js");

const PORT = Number(process.env.PORT || 10000);
const PUBLIC_DIR = path.join(__dirname, "public");
const M440_KEY = "X^Ib1O*HLVh%3W2t";

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

const chapterCache = new Map();

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": status === 200 ? "public, max-age=300" : "no-store",
  });
  res.end(body);
}

async function readBody(req, maxBytes = 2_000_000) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;

    if (total > maxBytes) {
      throw new Error("La información cifrada es demasiado grande");
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function decryptChapters(rawBody) {
  let encrypted = rawBody.trim();

  if (!encrypted) {
    throw new Error("No se recibió la información cifrada");
  }

  // Aidoku envía el literal JavaScript completo, incluyendo las comillas.
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
    throw new Error("No se pudo descifrar la lista de capítulos");
  }

  let chapters = JSON.parse(decrypted);

  // M440 guarda un JSON dentro de otro JSON.
  if (typeof chapters === "string") {
    chapters = JSON.parse(chapters);
  }

  if (!Array.isArray(chapters)) {
    throw new Error("La lista descifrada no es válida");
  }

  chapterCache.set(encrypted, {
    value: chapters,
    expiresAt: Date.now() + 30 * 60 * 1000,
  });

  return chapters;
}

function safeStaticPath(pathname) {
  const decoded = decodeURIComponent(pathname);
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const fullPath = path.resolve(PUBLIC_DIR, relative);

  if (!fullPath.startsWith(path.resolve(PUBLIC_DIR) + path.sep)) {
    return null;
  }

  return fullPath;
}

function serveStatic(pathname, res) {
  const fullPath = safeStaticPath(pathname);

  if (!fullPath || !fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    return false;
  }

  const extension = path.extname(fullPath).toLowerCase();
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".aix": "application/octet-stream",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
  };

  res.writeHead(200, {
    "Content-Type": contentTypes[extension] || "application/octet-stream",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": extension === ".json" ? "no-cache" : "public, max-age=3600",
  });

  fs.createReadStream(fullPath).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "*",
      });
      return res.end();
    }

    if (requestUrl.pathname === "/health") {
      return send(res, 200, "YRepo M440 OK");
    }

    if (requestUrl.pathname === "/m440/chapters") {
      if (req.method !== "POST") {
        return send(res, 405, "Este endpoint requiere POST");
      }

      const rawBody = await readBody(req);
      const chapters = decryptChapters(rawBody);

      return send(
        res,
        200,
        JSON.stringify(chapters),
        "application/json; charset=utf-8"
      );
    }

    if (requestUrl.pathname === "/") {
      const indexPath = path.join(PUBLIC_DIR, "index.min.json");
      const listExists = fs.existsSync(indexPath);

      return send(
        res,
        200,
        `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>YRepo M440</title>
<style>
body{font-family:system-ui;margin:40px;max-width:760px;line-height:1.5}
code{background:#f2f2f2;padding:4px 7px;border-radius:6px;word-break:break-all}
</style>
</head>
<body>
<h1>YRepo M440 activo</h1>
<p>Descifrador de capítulos: <strong>activo</strong>.</p>
<p>M440 se consulta directamente desde Aidoku; Render solo descifra la información.</p>
<p>Lista de Aidoku: ${
          listExists
            ? `<code>https://${req.headers.host}/index.min.json</code>`
            : "todavía no generada"
        }</p>
</body>
</html>`,
        "text/html; charset=utf-8"
      );
    }

    if (serveStatic(requestUrl.pathname, res)) {
      return;
    }

    return send(res, 404, "No encontrado");
  } catch (error) {
    console.error(error);
    return send(res, 500, `Error: ${error.message}`);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`YRepo M440 escuchando en el puerto ${PORT}`);
});

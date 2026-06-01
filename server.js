import express from "express";
import cors from "cors";
import mysql from "mysql2/promise";

const app = express();
const PORT = process.env.PORT || 10000;
app.use(cors());
app.use(express.json({ limit: "1mb" }));

let pool = null;

function cleanDatabaseUrl(url) {
  return String(url || "").replace(/[\?&]ssl=true/g, "");
}

async function getPool() {
  if (pool) return pool;
  const databaseUrl = process.env.DATABASE_URL || "";
  if (!databaseUrl) throw new Error("DATABASE_URL não configurado no Render.");
  pool = mysql.createPool({
    uri: cleanDatabaseUrl(databaseUrl),
    ssl: { minVersion: "TLSv1.2", rejectUnauthorized: false },
    waitForConnections: true,
    connectionLimit: 5,
    maxIdle: 5,
    idleTimeout: 60000,
    queueLimit: 0,
    enableKeepAlive: true,
  });
  return pool;
}

function normalize(text = "") {
  return String(text).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function titleCase(text) {
  return String(text || "")
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((word) => {
      const lower = word.toLowerCase();
      if (["a", "o", "as", "os", "de", "da", "do", "das", "dos", "e"].includes(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ")
    .replace(/^./, (c) => c.toUpperCase());
}

function checkToken(req, res) {
  const token = String(req.query.token || req.body?.token || "");
  const expected = String(process.env.COMMAND_SECRET || "carolina-add-watchlist");
  if (token !== expected) {
    res.status(403).type("text/plain").send("Token inválido.");
    return false;
  }
  return true;
}

function parseCommand(raw = "") {
  let q = String(raw || "").trim().replace(/^!add\s+/i, "").trim();
  const typeMatch = q.match(/^(filme|filmes|movie|serie|série|series|séries|anime|animes)\s+(.+)$/i);
  if (!typeMatch) return { error: "Use: !add filme nome ano | !add serie nome t1 | !add anime nome t1" };

  const rawType = normalize(typeMatch[1]);
  let rest = typeMatch[2].trim();

  let contentType = "Filme";
  let tmdbType = "movie";
  if (rawType.includes("serie")) {
    contentType = "Série";
    tmdbType = "tv";
  }
  if (rawType.includes("anime")) {
    contentType = "Anime";
    tmdbType = "tv";
  }

  let seasonNumber = null;
  const seasonMatch = rest.match(/\b(?:t|temp|temporada)\s*(\d{1,2})\b/i);
  if (seasonMatch) {
    seasonNumber = Number(seasonMatch[1]);
    rest = rest.replace(seasonMatch[0], "").trim();
  }

  let year = null;
  const yearMatches = [...rest.matchAll(/\b(19\d{2}|20\d{2})\b/g)];
  if (yearMatches.length > 0) {
    const last = yearMatches[yearMatches.length - 1][1];
    year = last;
    rest = rest.replace(new RegExp(`\\b${last}\\b`, "g"), "").trim();
  }

  const title = rest.replace(/\s+/g, " ").trim();
  if (!title) return { error: "Faltou o nome." };

  return { contentType, tmdbType, title, year, seasonNumber };
}

async function tmdbSearch(parsed) {
  const token = process.env.TMDB_ACCESS_TOKEN || "";
  const apiKey = process.env.TMDB_API_KEY || "";

  if (!token && !apiKey) {
    return { tmdbId: null, title: titleCase(parsed.title), year: parsed.year || null, imageUrl: "", description: "" };
  }

  const params = new URLSearchParams({ query: parsed.title, include_adult: "false", language: "pt-BR", page: "1" });
  if (parsed.year && parsed.tmdbType === "movie") params.set("year", parsed.year);
  if (parsed.year && parsed.tmdbType === "tv") params.set("first_air_date_year", parsed.year);

  const url = `https://api.themoviedb.org/3/search/${parsed.tmdbType}?${params.toString()}${apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : ""}`;
  const headers = token ? { Authorization: `Bearer ${token}`, accept: "application/json" } : { accept: "application/json" };

  try {
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error("TMDB falhou");
    const data = await response.json();
    const item = Array.isArray(data.results) ? data.results[0] : null;
    if (!item) throw new Error("TMDB sem resultado");

    const foundTitle = parsed.tmdbType === "movie" ? item.title : item.name;
    const date = parsed.tmdbType === "movie" ? item.release_date : item.first_air_date;
    return {
      tmdbId: item.id || null,
      title: foundTitle || titleCase(parsed.title),
      year: date ? String(date).slice(0, 4) : parsed.year || null,
      imageUrl: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : "",
      description: item.overview || "",
    };
  } catch {
    return { tmdbId: null, title: titleCase(parsed.title), year: parsed.year || null, imageUrl: "", description: "" };
  }
}

async function tableExists(db, table) {
  try { await db.query(`SELECT 1 FROM \`${table}\` LIMIT 1`); return true; } catch { return false; }
}

async function getColumns(db, table) {
  const [rows] = await db.query(`SHOW COLUMNS FROM \`${table}\``);
  return rows.map((row) => row.Field);
}

function pick(columns, ...names) {
  for (const name of names) if (columns.includes(name)) return name;
  return null;
}

async function getWatchlistInfo() {
  const db = await getPool();
  for (const table of ["watchlist", "watchlists"]) {
    if (await tableExists(db, table)) {
      return { db, table, columns: await getColumns(db, table) };
    }
  }
  throw new Error("Tabela watchlist/watchlists não encontrada.");
}

async function insertWatchlist(parsed, media) {
  const { db, table, columns } = await getWatchlistInfo();

  const values = {};
  const set = (col, value) => {
    if (col && value !== undefined && value !== null) values[col] = value;
  };

  const titleCol = pick(columns, "title", "name");
  const typeCol = pick(columns, "contentType", "content_type", "type");
  const activeCol = pick(columns, "isActive", "is_active");
  const orderCol = pick(columns, "displayOrder", "display_order", "order");

  set(pick(columns, "userId", "user_id"), Number(process.env.WATCHLIST_USER_ID || 1));
  set(titleCol, media?.title || titleCase(parsed.title));
  set(typeCol, parsed.contentType);
  set(activeCol, 1);
  set(pick(columns, "status"), "Na Fila");
  set(pick(columns, "tmdbId", "tmdb_id"), media?.tmdbId || undefined);
  set(pick(columns, "year"), media?.year || parsed.year || undefined);
  set(pick(columns, "imageUrl", "image_url", "posterUrl", "poster_url"), media?.imageUrl || "");
  set(pick(columns, "description"), media?.description || "");
  set(pick(columns, "seasonNumber", "season_number"), parsed.seasonNumber || undefined);

  // IMPORTANTE:
  // O admin do site parece ordenar por display_order ASC.
  // Para aparecer no começo da Watchlist, novos itens recebem número negativo.
  if (orderCol) set(orderCol, -Date.now());

  const now = new Date();
  set(pick(columns, "createdAt", "created_at"), now);
  set(pick(columns, "updatedAt", "updated_at"), now);

  if (!values[titleCol]) throw new Error("Coluna title/name não encontrada.");
  if (!values[typeCol]) throw new Error("Coluna contentType/type não encontrada.");

  const insertColumns = Object.keys(values);
  const sql = `INSERT INTO \`${table}\` (${insertColumns.map((c) => `\`${c}\``).join(", ")}) VALUES (${insertColumns.map(() => "?").join(", ")})`;
  const [result] = await db.query(sql, insertColumns.map((c) => values[c]));

  return {
    table,
    insertId: result?.insertId || null,
    title: values[titleCol],
    contentType: parsed.contentType,
    seasonNumber: parsed.seasonNumber,
    displayOrder: values[orderCol],
  };
}

async function handleAdd(req, res) {
  try {
    if (!checkToken(req, res)) return;
    const q = String(req.query.q || req.body?.q || "");
    const user = String(req.query.user || req.body?.user || "chat");

    const parsed = parseCommand(q);
    if (parsed.error) return res.status(200).type("text/plain").send(parsed.error);

    const media = await tmdbSearch(parsed);
    const inserted = await insertWatchlist(parsed, media);

    const seasonText = inserted.seasonNumber ? ` T${inserted.seasonNumber}` : "";
    res.status(200).type("text/plain").send(
      `✅ ${inserted.contentType}${seasonText} "${inserted.title}" adicionado.);
  } catch (error) {
    console.error(error);
    res.status(200).type("text/plain").send(`Erro ao adicionar: ${error.message}`);
  }
}

async function handleDebug(req, res) {
  try {
    if (!checkToken(req, res)) return;
    const { db, table, columns } = await getWatchlistInfo();
    const idCol = pick(columns, "id") || columns[0];
    const titleCol = pick(columns, "title", "name");
    const typeCol = pick(columns, "contentType", "content_type", "type");
    const activeCol = pick(columns, "isActive", "is_active");
    const orderCol = pick(columns, "displayOrder", "display_order", "order");
    const createdCol = pick(columns, "createdAt", "created_at");
    const selectCols = [idCol, titleCol, typeCol, activeCol, orderCol, createdCol].filter(Boolean);
    const order = orderCol ? `\`${orderCol}\` ASC` : (createdCol ? `\`${createdCol}\` DESC` : `\`${idCol}\` DESC`);
    const [rows] = await db.query(`SELECT ${selectCols.map((c) => `\`${c}\``).join(", ")} FROM \`${table}\` ORDER BY ${order} LIMIT 30`);
    res.type("text/plain").send(`Tabela: ${table}\nColunas: ${columns.join(", ")}\n\nItens no topo da ordem do admin:\n` + rows.map((r) => JSON.stringify(r)).join("\n"));
  } catch (error) {
    res.status(200).type("text/plain").send(`Erro debug: ${error.message}`);
  }
}

app.get("/", (_req, res) => res.type("text/plain").send("OK - API StreamElements Watchlist"));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/add", handleAdd);
app.post("/add", handleAdd);
app.get("/debug", handleDebug);

app.listen(PORT, () => console.log(`API rodando na porta ${PORT}`));

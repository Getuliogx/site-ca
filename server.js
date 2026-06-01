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
  if (!token && !apiKey) return null;

  const params = new URLSearchParams({
    query: parsed.title,
    include_adult: "false",
    language: "pt-BR",
    page: "1",
  });

  if (parsed.year && parsed.tmdbType === "movie") params.set("year", parsed.year);
  if (parsed.year && parsed.tmdbType === "tv") params.set("first_air_date_year", parsed.year);

  const url = `https://api.themoviedb.org/3/search/${parsed.tmdbType}?${params.toString()}${apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : ""}`;
  const headers = token ? { Authorization: `Bearer ${token}`, accept: "application/json" } : { accept: "application/json" };

  try {
    const response = await fetch(url, { headers });
    if (!response.ok) return null;
    const data = await response.json();
    const item = Array.isArray(data.results) ? data.results[0] : null;
    if (!item) return null;

    const title = parsed.tmdbType === "movie" ? item.title : item.name;
    const date = parsed.tmdbType === "movie" ? item.release_date : item.first_air_date;

    return {
      tmdbId: item.id || null,
      title: title || parsed.title,
      year: date ? String(date).slice(0, 4) : parsed.year || null,
      imageUrl: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : "",
      description: item.overview || "",
    };
  } catch {
    return null;
  }
}

async function tableExists(db, table) {
  try {
    await db.query(`SELECT 1 FROM \`${table}\` LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

async function getTableColumns(db, table) {
  const [rows] = await db.query(`SHOW COLUMNS FROM \`${table}\``);
  return rows.map((row) => row.Field);
}

function pickColumn(columns, ...names) {
  for (const name of names) if (columns.includes(name)) return name;
  return null;
}

async function resolveWatchlistTable(db) {
  for (const table of ["watchlist", "watchlists"]) {
    if (await tableExists(db, table)) return table;
  }
  throw new Error("Tabela watchlist/watchlists não encontrada.");
}

async function insertWatchlist(parsed, media) {
  const db = await getPool();
  const table = await resolveWatchlistTable(db);
  const columns = await getTableColumns(db, table);

  const values = {};
  const set = (col, value) => {
    if (col && value !== undefined && value !== null) values[col] = value;
  };

  const typeCol = pickColumn(columns, "contentType", "content_type", "type");

  set(pickColumn(columns, "userId", "user_id"), Number(process.env.WATCHLIST_USER_ID || 1));
  set(pickColumn(columns, "title", "name"), media?.title || parsed.title);
  set(typeCol, parsed.contentType);
  set(pickColumn(columns, "status"), "Na Fila");
  set(pickColumn(columns, "isActive", "is_active"), 1);
  set(pickColumn(columns, "tmdbId", "tmdb_id"), media?.tmdbId || undefined);
  set(pickColumn(columns, "year"), media?.year || parsed.year || undefined);
  set(pickColumn(columns, "imageUrl", "image_url", "posterUrl", "poster_url"), media?.imageUrl || undefined);
  set(pickColumn(columns, "description"), media?.description || undefined);
  set(pickColumn(columns, "seasonNumber", "season_number"), parsed.seasonNumber || undefined);

  const orderCol = pickColumn(columns, "displayOrder", "display_order", "order");
  if (orderCol) {
    try {
      const [rows] = await db.query(`SELECT COALESCE(MAX(\`${orderCol}\`), 0) + 1 AS nextOrder FROM \`${table}\``);
      set(orderCol, rows?.[0]?.nextOrder || 1);
    } catch {
      set(orderCol, 1);
    }
  }

  const now = new Date();
  set(pickColumn(columns, "createdAt", "created_at"), now);
  set(pickColumn(columns, "updatedAt", "updated_at"), now);

  if (!values[pickColumn(columns, "title", "name")]) throw new Error("Campo title/name não encontrado.");
  if (!values[typeCol]) throw new Error("Campo contentType/type não encontrado.");

  const insertColumns = Object.keys(values);
  const placeholders = insertColumns.map(() => "?").join(", ");
  const sql = `INSERT INTO \`${table}\` (${insertColumns.map((c) => `\`${c}\``).join(", ")}) VALUES (${placeholders})`;
  await db.query(sql, insertColumns.map((c) => values[c]));

  return { title: values[pickColumn(columns, "title", "name")], contentType: parsed.contentType, seasonNumber: parsed.seasonNumber };
}

async function handleAdd(req, res) {
  try {
    const token = String(req.query.token || req.body?.token || "");
    const expected = String(process.env.COMMAND_SECRET || "carolina-add-watchlist");
    if (token !== expected) return res.status(403).type("text/plain").send("Token inválido.");

    const q = String(req.query.q || req.body?.q || "");
    const user = String(req.query.user || req.body?.user || "chat");

    const parsed = parseCommand(q);
    if (parsed.error) return res.status(200).type("text/plain").send(parsed.error);

    const media = await tmdbSearch(parsed);
    const inserted = await insertWatchlist(parsed, media);

    const seasonText = inserted.seasonNumber ? ` T${inserted.seasonNumber}` : "";
    res.status(200).type("text/plain").send(`✅ ${inserted.contentType}${seasonText} "${inserted.title}" adicionada na Watchlist por ${user}.`);
  } catch (error) {
    console.error(error);
    res.status(200).type("text/plain").send(`Erro ao adicionar: ${error.message}`);
  }
}

app.get("/", (_req, res) => res.type("text/plain").send("OK - API StreamElements Watchlist"));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/add", handleAdd);
app.post("/add", handleAdd);

app.listen(PORT, () => console.log(`API rodando na porta ${PORT}`));

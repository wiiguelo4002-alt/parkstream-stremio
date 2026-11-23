// ParkStream para Stremio (Netlify Edge Function).
// Porta do stream_resolver.py do addon Kodi ParkStream (GPL-2.0).

const IMDB_ID = "tt0121955"; // South Park
const readEnv = (k) => {
  try { return Netlify.env.get(k); } catch { /* sem Netlify */ }
  try { return Deno.env.get(k); } catch { /* sem Deno */ }
  return undefined;
};
const REGIONS = (readEnv("REGIONS") || "br,eu").split(",").map((s) => s.trim()).filter(Boolean);
const UA = "Mozilla/5.0 (Windows NT 6.1; rv:25.0) Gecko/20100101 Firefox/25.0";
const DATA_URL = (r) =>
  `https://raw.githubusercontent.com/wargio/plugin.video.southpark_unofficial/addon-data/addon-data-${r}.json`;

const DOMAINS = {
  en: "https://www.southpark.de/en",
  es: "https://southparkstudios.com",
  de: "https://www.southpark.de",
  se: "https://www.southparkstudios.nu",
  eu: "https://www.southparkstudios.com",
  br: "https://www.southparkstudios.com.br",
  lat: "https://www.southpark.lat",
};
const LABELS = { br: "Português (BR)", eu: "English", en: "English", es: "Español", de: "Deutsch", se: "Svenska", lat: "Español (LatAm)" };

const MANIFEST = {
  id: "community.parkstream.southpark",
  version: "1.1.0",
  name: "ParkStream (South Park)",
  description: "Episódios de South Park a partir dos sites oficiais. Baseado no addon Kodi ParkStream (GPL-2.0).",
  resources: ["stream"],
  types: ["series"],
  idPrefixes: [IMDB_ID],
  catalogs: [],
};

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Cache-Control": "max-age=60",
};

const caches = {}; // região -> { time, episodes }

async function getJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
    return JSON.parse(await res.text());
  } finally {
    clearTimeout(timer);
  }
}

async function loadEpisodes(region) {
  const c = caches[region];
  if (c && Date.now() - c.time < 12 * 3600 * 1000) return c.episodes;
  const data = await getJson(DATA_URL(region));
  const episodes = data.seasons.flat();
  caches[region] = { time: Date.now(), episodes };
  return episodes;
}

function withQuery(url, params) {
  const u = new URL(url);
  u.search = new URLSearchParams(params).toString();
  return u.toString();
}

function* walk(value) {
  if (Array.isArray(value)) {
    for (const v of value) yield* walk(v);
  } else if (value && typeof value === "object") {
    yield value;
    for (const v of Object.values(value)) yield* walk(v);
  }
}

function findVideoDetail(data) {
  for (const n of walk(data)) {
    if (n.type === "Player" && n.props && typeof n.props.videoDetail === "object" && n.props.videoDetail) {
      return n.props.videoDetail;
    }
  }
  for (const n of walk(data)) {
    if (n.videoDetail && typeof n.videoDetail === "object") return n.videoDetail;
  }
  return null;
}

const isHttp = (u) => {
  try { return ["http:", "https:"].includes(new URL(u).protocol); } catch { return false; }
};

async function resolveEpisode(region, epUrl) {
  const domain = DOMAINS[region];
  if (!domain || !epUrl) throw new Error("Página do episódio indisponível");
  const pageUrl = new URL(epUrl.replace(/^\//, ""), domain + "/").toString();
  const page = await getJson(withQuery(pageUrl, { json: "true" }));
  const detail = findVideoDetail(page);
  if (!detail) throw new Error("Detalhes do vídeo ausentes");
  if (detail.authRequired) throw new Error("Vídeo exige autenticação");
  if (!detail.mgid || !isHttp(detail.videoServiceUrl)) throw new Error("Conteúdo indisponível");
  const svc = await getJson(withQuery(detail.videoServiceUrl.split("?")[0], { clientPlatform: "desktop" }));
  const st = svc.stitchedstream;
  const type = st && typeof st.manifesttype === "string" ? st.manifesttype.toLowerCase() : null;
  if (!st || type !== "hls" || !isHttp(st.source)) throw new Error("Manifesto indisponível");
  return st.source;
}

async function streamForRegion(region, season, number) {
  const eps = await loadEpisodes(region);
  const ep = eps.find((x) => Number(x.season) === season && Number(x.episode) === number);
  if (!ep) return null;
  const source = await resolveEpisode(region, ep.url);
  return {
    name: "ParkStream",
    title: `${ep.title || "South Park"}\n${LABELS[region] || region} - site oficial`,
    url: source,
    behaviorHints: { notWebReady: true },
  };
}

async function streamsFor(videoId) {
  const [id, s, e] = videoId.split(":");
  const season = parseInt(s, 10), number = parseInt(e, 10);
  if (id !== IMDB_ID || !season || !number) return [];
  const results = await Promise.allSettled(REGIONS.map((r) => streamForRegion(r, season, number)));
  const streams = [];
  results.forEach((res, i) => {
    if (res.status === "fulfilled" && res.value) streams.push(res.value);
    else if (res.status === "rejected") console.log(`[parkstream] falha (${REGIONS[i]}) em ${videoId}: ${res.reason && res.reason.message}`);
  });
  return streams;
}

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: HEADERS });

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
  const path = decodeURIComponent(new URL(request.url).pathname);
  if (path === "/manifest.json") return reply(200, MANIFEST);
  const m = path.match(/^\/stream\/series\/(.+?)(?:\.json)?$/);
  if (m) {
    try {
      return reply(200, { streams: await streamsFor(m[1]) });
    } catch (err) {
      console.log(`[parkstream] erro: ${err.message}`);
      return reply(200, { streams: [] });
    }
  }
  return reply(404, { error: "not found" });
};

export const config = { path: ["/manifest.json", "/stream/series/*"] };

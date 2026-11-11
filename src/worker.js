import { DurableObject } from "cloudflare:workers";
import { executarBot, NOME_BOT } from "./bots.js";

const CANAIS = ["geral", "jogos", "futebol", "bots"];
const HISTORICO_POR_CANAL = 100;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Esperado WebSocket", { status: 426 });
      }
      const servidor = (url.searchParams.get("servidor") || "principal").slice(0, 40);
      const stub = env.SALA.get(env.SALA.idFromName(servidor));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

// Um "servidor" da Salinha: guarda o chat e repassa mensagens/sinais entre as pessoas.
// Voz e vídeo NÃO passam por aqui: vão direto de navegador pra navegador (WebRTC).
export class Sala extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS mensagens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      canal TEXT, autor TEXT, texto TEXT, bot INTEGER, ts INTEGER)`);
    // Estado do "Assistir junto" (vídeo atual + fila)
    ctx.blockConcurrencyWhile(async () => {
      this.assistir = (await ctx.storage.get("assistir")) ||
        { videoId: null, titulo: "", tocando: false, posicao: 0, atualizadoEm: Date.now(), fila: [], ultimaAcao: "" };
    });
  }

  async fetch() {
    const par = new WebSocketPair();
    const [cliente, servidor] = Object.values(par);
    this.ctx.acceptWebSocket(servidor);
    servidor.serializeAttachment({ id: crypto.randomUUID().slice(0, 8), nome: null, voz: false, midia: {} });
    return new Response(null, { status: 101, webSocket: cliente });
  }

  // ---------- helpers ----------
  conexoes(excluir) {
    return this.ctx.getWebSockets().filter((w) => w !== excluir && w.readyState === 1);
  }

  usuarios(excluir) {
    const lista = [];
    for (const w of this.conexoes(excluir)) {
      const u = w.deserializeAttachment();
      if (u && u.nome) lista.push(u);
    }
    return lista;
  }

  enviar(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }

  transmitir(obj, excluir) {
    const txt = JSON.stringify(obj);
    for (const w of this.conexoes(excluir)) {
      const u = w.deserializeAttachment();
      if (u && u.nome) { try { w.send(txt); } catch {} }
    }
  }

  avisarUsuarios(excluir) {
    this.transmitir({ t: "usuarios", lista: this.usuarios(excluir) }, excluir);
  }

  historico() {
    const h = {};
    for (const canal of CANAIS) {
      h[canal] = this.sql
        .exec("SELECT autor, texto, bot, ts FROM mensagens WHERE canal = ? ORDER BY id DESC LIMIT 50", canal)
        .toArray()
        .reverse()
        .map((m) => ({ ...m, canal, bot: !!m.bot }));
    }
    return h;
  }

  salvarETransmitir(canal, autor, texto, bot) {
    const ts = Date.now();
    this.sql.exec("INSERT INTO mensagens (canal, autor, texto, bot, ts) VALUES (?, ?, ?, ?, ?)", canal, autor, texto, bot ? 1 : 0, ts);
    this.sql.exec(
      "DELETE FROM mensagens WHERE canal = ? AND id NOT IN (SELECT id FROM mensagens WHERE canal = ? ORDER BY id DESC LIMIT ?)",
      canal, canal, HISTORICO_POR_CANAL
    );
    this.transmitir({ t: "msg", canal, autor, texto, bot, ts });
  }

  // ---------- eventos do WebSocket ----------
  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 100_000) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const eu = ws.deserializeAttachment();

    if (m.t === "entrar") {
      eu.nome = String(m.nome || "").trim().slice(0, 24) || "Anônimo";
      ws.serializeAttachment(eu);
      await this.carregarFutebol();
      this.enviar(ws, { t: "bemvindo", id: eu.id, canais: CANAIS, historico: this.historico(), assistir: this.assistir, agora: Date.now(), futebol: this.dadosFutebol() });
      // liga o acompanhamento dos jogos enquanto tiver gente online
      if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 300);
      this.avisarUsuarios();
      this.transmitir({ t: "sistema", texto: `${eu.nome} entrou` }, ws);
      return;
    }
    if (!eu.nome) return;

    switch (m.t) {
      case "msg": {
        const canal = CANAIS.includes(m.canal) ? m.canal : "geral";
        const texto = String(m.texto || "").trim().slice(0, 2000);
        if (!texto) return;
        this.salvarETransmitir(canal, eu.nome, texto, false);
        const resposta = executarBot(texto, { autor: eu.nome, canal, usuarios: this.usuarios(), futebol: this.futebol ? this.dadosFutebol() : null });
        if (resposta) this.salvarETransmitir(canal, NOME_BOT, String(resposta).slice(0, 2000), true);
        break;
      }
      case "voz":
        eu.voz = !!m.ativo;
        if (!eu.voz) eu.midia = {};
        ws.serializeAttachment(eu);
        this.avisarUsuarios();
        break;
      case "midia":
        eu.midia = { mic: !!m.mic, cam: !!m.cam, tela: !!m.tela, camId: String(m.camId || "").slice(0, 100), telaId: String(m.telaId || "").slice(0, 100) };
        ws.serializeAttachment(eu);
        this.avisarUsuarios();
        break;
      case "sinal": // WebRTC: repassa oferta/resposta/candidatos pra pessoa certa
        for (const w of this.conexoes()) {
          if (w.deserializeAttachment()?.id === m.para) {
            this.enviar(w, { t: "sinal", de: eu.id, dados: m.dados });
            break;
          }
        }
        break;
      case "assistir":
        await this.acaoAssistir(m, eu);
        break;
      case "noticias": {
        const cat = m.cat === "futebol" ? "futebol" : "geral";
        const dados = await this.noticias(cat, !!m.forcar);
        this.enviar(ws, { t: "noticias", cat, ...dados });
        break;
      }
      case "assistindo": // quem está com a sessão do "Assistir junto" aberta
        eu.assistindo = !!m.ativo;
        ws.serializeAttachment(eu);
        this.avisarUsuarios();
        break;
      case "jogo": // repassa dados do jogo pra todo mundo (menos quem mandou)
        this.transmitir({ t: "jogo", jogo: String(m.jogo || ""), de: eu.id, nome: eu.nome, dados: m.dados }, ws);
        break;
    }
  }

  // ---------- Estádio (Brasileirão, dados da ESPN) ----------
  async carregarFutebol() {
    if (!this.futebol) this.futebol = (await this.ctx.storage.get("futebol")) || { jogos: {}, tabela: [], atualizadoEm: 0, tabelaEm: 0, historicoEm: 0 };
    return this.futebol;
  }

  dadosFutebol() {
    const f = this.futebol;
    return { jogos: Object.values(f.jogos).sort((a, b) => a.data.localeCompare(b.data)), tabela: f.tabela, atualizadoEm: f.atualizadoEm };
  }

  async alarm() {
    if (!this.conexoes().length) return; // ninguém online: para de consultar
    try { await this.atualizarFutebol(); } catch (e) { console.log("futebol:", e.message); }
    const agora = Date.now();
    const jogos = Object.values(this.futebol.jogos);
    const aoVivo = jogos.some((j) => j.estado === "in");
    const perto = jogos.some((j) => j.estado === "pre" && new Date(j.data) - agora < 20 * 60e3 && agora - new Date(j.data) < 3 * 3600e3);
    await this.ctx.storage.setAlarm(agora + (aoVivo ? 30e3 : perto ? 60e3 : 15 * 60e3));
  }

  async atualizarFutebol() {
    const f = await this.carregarFutebol();
    const agora = Date.now();
    const base = ESPN + "/site/v2/sports/soccer/bra.1/scoreboard?lang=pt&region=br";
    const urls = [base, base + "&dates=" + diaBR(0)];
    const completo = agora - f.historicoEm > 3600e3; // de hora em hora: últimos 7 dias e próximos 7
    if (completo) for (let d = -7; d <= 7; d++) if (d) urls.push(base + "&dates=" + diaBR(d));
    const pedirTabela = agora - f.tabelaEm > 10 * 60e3;
    const [respostas, tabela] = await Promise.all([
      Promise.allSettled(urls.map(buscarJSON)),
      pedirTabela ? buscarJSON(ESPN + "/v2/sports/soccer/bra.1/standings?lang=pt&region=br").catch(() => null) : null,
    ]);
    if (respostas.every((r) => r.status === "rejected")) throw new Error("ESPN fora do ar");

    const avisar = f.atualizadoEm && agora - f.atualizadoEm < 5 * 60e3; // dado antigo demais: não solta alerta atrasado
    const eventos = [];
    for (const r of respostas) {
      if (r.status !== "fulfilled") continue;
      for (const e of r.value.events || []) {
        const novo = resumirJogo(e); if (!novo) continue;
        const antes = f.jogos[novo.id];
        if (avisar && antes) eventos.push(...compararJogo(antes, novo));
        f.jogos[novo.id] = novo;
      }
    }
    for (const [id, j] of Object.entries(f.jogos)) if (agora - new Date(j.data) > 9 * 864e5) delete f.jogos[id];
    if (tabela) { const t = resumirTabela(tabela); if (t.length) { f.tabela = t; f.tabelaEm = agora; } }
    if (completo) f.historicoEm = agora;
    if (eventos.some((e) => e.tipo === "fim")) f.tabelaEm = 0; // acabou jogo: atualiza a tabela na próxima
    f.atualizadoEm = agora;
    await this.ctx.storage.put("futebol", f);

    this.transmitir({ t: "futebol", dados: this.dadosFutebol() });
    const vistos = new Set();
    for (const ev of eventos) {
      if (vistos.has(ev.texto)) continue; vistos.add(ev.texto);
      this.salvarETransmitir("futebol", NOME_BOT, ev.texto, true);
      if (ev.tipo === "gol") this.transmitir({ t: "gol", ...ev });
    }
  }

  // ---------- Notícias (feeds dos sites) ----------
  async noticias(cat, forcar) {
    this.cacheNoticias ||= {};
    let c = this.cacheNoticias[cat] || (this.cacheNoticias[cat] = (await this.ctx.storage.get("noticias-" + cat)) || { itens: [], atualizadoEm: 0 });
    const idade = Date.now() - c.atualizadoEm;
    if (idade > 10 * 60e3 || (forcar && idade > 60e3)) {
      this.buscandoNoticias ||= {};
      this.buscandoNoticias[cat] ||= buscarNoticias(cat).finally(() => { this.buscandoNoticias[cat] = null; });
      const itens = await this.buscandoNoticias[cat];
      if (itens.length) {
        c = this.cacheNoticias[cat] = { itens, atualizadoEm: Date.now() };
        await this.ctx.storage.put("noticias-" + cat, c);
      }
    }
    return c;
  }

  // ---------- Assistir junto ----------
  async acaoAssistir(m, eu) {
    const a = this.assistir;
    const agora = Date.now();
    const posAgora = () => a.posicao + (a.tocando ? (agora - a.atualizadoEm) / 1000 : 0);
    const num = (v, padrao) => (typeof v === "number" && isFinite(v) && v >= 0 ? v : padrao);
    const iniciar = (item) => { a.videoId = item.videoId; a.tipo = item.tipo; a.ref = item.ref; a.titulo = item.titulo; a.tocando = true; a.posicao = 0; a.noAoVivo = true; };
    let acao = "";

    switch (m.acao) {
      case "tocar":
      case "fila": {
        const link = interpretarLink(m.url);
        if (!link) return;
        const item = { ...link, titulo: await tituloDoLink(link), por: eu.nome };
        if (m.acao === "tocar" || !a.videoId) { iniciar(item); acao = `${eu.nome} colocou: ${item.titulo}`; }
        else { a.fila.push(item); a.fila = a.fila.slice(0, 50); acao = `${eu.nome} adicionou na fila: ${item.titulo}`; }
        break;
      }
      case "play":
        if (!a.videoId) return;
        a.posicao = num(m.posicao, posAgora()); a.tocando = true; a.noAoVivo = false; acao = `${eu.nome} deu play`;
        break;
      case "pause":
        if (!a.videoId) return;
        a.posicao = num(m.posicao, posAgora()); a.tocando = false; a.noAoVivo = false; acao = `${eu.nome} pausou`;
        break;
      case "seek":
        if (!a.videoId) return;
        a.posicao = num(m.posicao, posAgora()); a.noAoVivo = false; acao = `${eu.nome} pulou o vídeo`;
        break;
      case "aovivo": // live: todo mundo volta pro ao vivo
        if (!a.videoId) return;
        a.noAoVivo = true; a.tocando = true; acao = `${eu.nome} voltou todo mundo pro 🔴 ao vivo`;
        break;
      case "fim": // vários clientes avisam; só avança uma vez
        if (m.videoId !== a.videoId) return;
        // fallthrough
      case "proximo":
        if (a.fila.length) { const prox = a.fila.shift(); iniciar(prox); acao = `Tocando: ${prox.titulo}`; }
        else { a.tocando = false; a.posicao = m.acao === "fim" ? posAgora() : a.posicao; acao = m.acao === "fim" ? "Fila acabou" : "Fila vazia"; }
        break;
      case "remover":
        if (!(m.indice >= 0 && m.indice < a.fila.length)) return;
        acao = `${eu.nome} tirou da fila: ${a.fila.splice(m.indice, 1)[0].titulo}`;
        break;
      case "parar":
        a.videoId = null; a.tipo = null; a.ref = null; a.titulo = ""; a.tocando = false; a.posicao = 0; acao = `${eu.nome} parou o vídeo`;
        break;
      default:
        return;
    }
    a.atualizadoEm = Date.now();
    a.ultimaAcao = acao;
    await this.ctx.storage.put("assistir", a);
    this.transmitir({ t: "assistir", estado: a, agora: Date.now() });
  }

  async webSocketClose(ws, code) {
    this.saiu(ws);
    try { ws.close(1000, "tchau"); } catch {}
  }

  async webSocketError(ws) {
    this.saiu(ws);
  }

  saiu(ws) {
    const eu = ws.deserializeAttachment();
    if (!eu?.nome) return;
    this.avisarUsuarios(ws);
    this.transmitir({ t: "sistema", texto: `${eu.nome} saiu` }, ws);
  }
}

// ---------- helpers de links (YouTube e Twitch) ----------
function interpretarLink(url) {
  const txt = String(url || "").trim();
  const vod = txt.match(/twitch\.tv\/videos\/(\d+)/i);
  if (vod) return { tipo: "twitch-vod", ref: vod[1], videoId: "twv:" + vod[1] };
  const canal = txt.match(/twitch\.tv\/([a-z0-9_]{3,25})(?:[\/?#]|$)/i);
  if (canal && !["videos", "directory", "p", "settings", "search", "downloads"].includes(canal[1].toLowerCase())) {
    const c = canal[1].toLowerCase();
    return { tipo: "twitch-live", ref: c, videoId: "twl:" + c };
  }
  const yt = idDoYoutube(txt);
  if (yt) return { tipo: "youtube", ref: yt, videoId: yt };
  return null;
}

async function tituloDoLink(link) {
  if (link.tipo === "twitch-live") return `🟣 ${link.ref} (Twitch ao vivo)`;
  if (link.tipo === "twitch-vod") return `🟣 Vídeo da Twitch #${link.ref}`;
  return tituloDoYoutube(link.ref);
}

function idDoYoutube(url) {
  const txt = String(url || "").trim();
  if (/^[\w-]{11}$/.test(txt)) return txt;
  const m = txt.match(/(?:youtu\.be\/|v=|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/);
  return m ? m[1] : null;
}

async function tituloDoYoutube(videoId) {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, { signal: AbortSignal.timeout(4000) });
    if (r.ok) return String((await r.json()).title || "").slice(0, 150) || "Vídeo do YouTube";
  } catch {}
  return "Vídeo do YouTube";
}

// ---------- helpers do futebol ----------
const ESPN = "https://site.api.espn.com/apis";
// dia no horário de Brasília, formato AAAAMMDD
function diaBR(offset = 0) {
  return new Date(Date.now() - 3 * 3600e3 + offset * 864e5).toISOString().slice(0, 10).replace(/-/g, "");
}
async function buscarJSON(url) {
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Salinha)" }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
function resumirJogo(e) {
  const c = e.competitions?.[0];
  const casa = c?.competitors?.find((x) => x.homeAway === "home"), fora = c?.competitors?.find((x) => x.homeAway === "away");
  if (!casa || !fora || !e.date) return null;
  const time = (x) => ({
    id: String(x.team?.id || x.id || ""), nome: x.team?.shortDisplayName || x.team?.displayName || "?",
    sigla: x.team?.abbreviation || "", logo: x.team?.logo || "", gols: parseInt(x.score) || 0,
  });
  const gols = (c.details || []).filter((d) => d.scoringPlay).map((d) => ({
    min: d.clock?.displayValue || "",
    lado: String(d.team?.id) === String(casa.team?.id || casa.id) ? "casa" : "fora",
    autor: d.athletesInvolved?.[0]?.shortName || d.athletesInvolved?.[0]?.displayName || "",
    contra: !!d.ownGoal, penalti: !!d.penaltyKick,
  }));
  const tipo = e.status?.type || {};
  return {
    id: String(e.id), data: e.date, estado: tipo.state || "pre", fase: tipo.name || "", desc: tipo.description || "",
    relogio: e.status?.displayClock || "", casa: time(casa), fora: time(fora), gols, estadio: c.venue?.fullName || "",
  };
}
function compararJogo(a, n) {
  const ev = [], placar = `${n.casa.nome} ${n.casa.gols} x ${n.fora.gols} ${n.fora.nome}`;
  if (a.estado === "pre" && n.estado === "in") ev.push({ tipo: "inicio", texto: `🟢 Começou: ${n.casa.nome} x ${n.fora.nome}` });
  for (const lado of ["casa", "fora"]) {
    if (n[lado].gols > a[lado].gols && n.estado !== "pre") {
      const ultimo = [...n.gols].reverse().find((g) => g.lado === lado);
      const autor = ultimo?.autor ? ` — ${ultimo.autor}${ultimo.penalti ? " (pênalti)" : ultimo.contra ? " (contra)" : ""}` : "";
      const min = n.estado === "in" && n.relogio ? ` (${n.relogio})` : "";
      ev.push({ tipo: "gol", jogo: n.id, time: n[lado].nome, timeId: n[lado].id, logo: n[lado].logo, placar, texto: `⚽ GOL do ${n[lado].nome}! ${placar}${min}${autor}` });
    } else if (n[lado].gols < a[lado].gols) {
      ev.push({ tipo: "anulado", texto: `🚫 Gol do ${n[lado].nome} anulado. ${placar}` });
    }
  }
  if (a.estado === "in" && a.fase !== "STATUS_HALFTIME" && n.fase === "STATUS_HALFTIME") ev.push({ tipo: "intervalo", texto: `⏸️ Intervalo: ${placar}` });
  if (a.estado !== "post" && n.estado === "post") ev.push({ tipo: "fim", texto: `🏁 Fim de jogo: ${placar}` });
  return ev;
}
function resumirTabela(t) {
  const linhas = t.children?.[0]?.standings?.entries || [];
  return linhas.map((l) => {
    const s = Object.fromEntries((l.stats || []).map((x) => [x.name, x.value]));
    return {
      id: String(l.team?.id || ""), nome: l.team?.shortDisplayName || l.team?.displayName || "?", sigla: l.team?.abbreviation || "", logo: l.team?.logos?.[0]?.href || "",
      pos: s.rank || 0, pts: s.points || 0, j: s.gamesPlayed || 0, v: s.wins || 0, e: s.ties || 0, d: s.losses || 0, sg: s.pointDifferential || 0,
    };
  }).sort((a, b) => a.pos - b.pos);
}

// ---------- helpers das notícias ----------
const FONTES = {
  futebol: [
    { nome: "ge", url: "https://ge.globo.com/rss/ge/futebol/" },
    { nome: "ESPN", url: "https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1/news?lang=pt&region=br&limit=30", json: "espn" },
    { nome: "Gazeta Esportiva", url: "https://www.gazetaesportiva.com/feed/" },
    { nome: "Estadão", url: "https://www.estadao.com.br/arc/outboundfeeds/feeds/rss/sections/esportes/futebol/" },
    { nome: "Folha", url: "https://feeds.folha.uol.com.br/esporte/rss091.xml" },
    { nome: "Agência Brasil", url: "https://agenciabrasil.ebc.com.br/rss/esportes/feed.xml" },
  ],
  geral: [
    { nome: "g1", url: "https://g1.globo.com/rss/g1/" },
    { nome: "BBC Brasil", url: "https://feeds.bbci.co.uk/portuguese/rss.xml" },
    { nome: "CNN Brasil", url: "https://www.cnnbrasil.com.br/feed/" },
    { nome: "Folha", url: "https://feeds.folha.uol.com.br/emcimadahora/rss091.xml" },
    { nome: "Agência Brasil", url: "https://agenciabrasil.ebc.com.br/rss/ultimasnoticias/feed.xml" },
    { nome: "Poder360", url: "https://www.poder360.com.br/feed/" },
    { nome: "Metrópoles", url: "https://www.metropoles.com/feed" },
  ],
};

async function buscarNoticias(cat) {
  const lotes = await Promise.allSettled(FONTES[cat].map(async (f) => {
    const r = await fetch(f.url, { headers: { "user-agent": "Mozilla/5.0 (Salinha)" }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(f.nome + " HTTP " + r.status);
    if (f.json === "espn") {
      const j = await r.json();
      return (j.articles || []).slice(0, 25).map((a) => ({
        titulo: a.headline || "", link: a.links?.web?.href || "", resumo: a.description || "",
        imagem: a.images?.[0]?.url || "", data: a.published || "", fonte: f.nome,
      }));
    }
    const bytes = new Uint8Array(await r.arrayBuffer());
    const cabeca = new TextDecoder("latin1").decode(bytes.slice(0, 200)) + (r.headers.get("content-type") || "");
    const xml = /iso-8859-1|windows-1252/i.test(cabeca) ? latin1(bytes) : new TextDecoder().decode(bytes);
    return lerRSS(xml, f.nome).slice(0, 25);
  }));
  const vistos = new Set(), itens = [];
  for (const l of lotes) {
    if (l.status !== "fulfilled") { console.log("notícias:", l.reason?.message); continue; }
    for (const n of l.value) {
      if (!n.titulo || !/^https?:\/\//.test(n.link)) continue;
      const chave = n.titulo.toLowerCase().replace(/[^a-z0-9à-ú]/g, "").slice(0, 60);
      if (vistos.has(chave) || vistos.has(n.link)) continue;
      vistos.add(chave); vistos.add(n.link);
      const t = Date.parse(n.data);
      itens.push({ ...n, titulo: n.titulo.slice(0, 200), resumo: n.resumo.slice(0, 240), data: isNaN(t) ? 0 : t });
    }
  }
  return itens.sort((a, b) => b.data - a.data).slice(0, 120);
}

function latin1(bytes) {
  let s = ""; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return s;
}
function textoLimpo(t) {
  return String(t || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}
function lerRSS(xml, fonte) {
  const itens = [];
  for (const [, it] of xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/g)) {
    const tag = (n) => { const m = it.match(new RegExp("<" + n + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + n + ">")); return m ? m[1] : ""; };
    const bruto = tag("description") + tag("content:encoded");
    const img = it.match(/<media:(?:content|thumbnail)[^>]*url="([^"]+)"/)?.[1]
      || it.match(/<enclosure[^>]*url="([^"]+)"[^>]*type="image/)?.[1]
      || bruto.match(/<img[^>]*src=["']([^"']+)["']/)?.[1]
      || textoLimpo(bruto).match(/https?:\/\/\S+\.(?:jpe?g|png|webp)/i)?.[0] || "";
    let resumo = textoLimpo(tag("atom:subtitle")) || textoLimpo(tag("description"));
    if (resumo.length > 240) resumo = resumo.slice(0, 237).replace(/\s\S*$/, "") + "…";
    itens.push({
      titulo: textoLimpo(tag("title")), link: textoLimpo(tag("link")) || textoLimpo(tag("guid")),
      resumo, imagem: img.replace(/&amp;/g, "&"), data: textoLimpo(tag("pubDate")) || textoLimpo(tag("dc:date")), fonte,
    });
  }
  return itens;
}

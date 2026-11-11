import { DurableObject } from "cloudflare:workers";
import { executarBot, NOME_BOT } from "./bots.js";

const CANAIS = ["geral", "jogos", "bots"];
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
      this.enviar(ws, { t: "bemvindo", id: eu.id, canais: CANAIS, historico: this.historico(), assistir: this.assistir, agora: Date.now() });
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
        const resposta = executarBot(texto, { autor: eu.nome, canal, usuarios: this.usuarios() });
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
      case "pos": { // Sala 2D: posição do boneco
        if (m.sair) { delete eu.pos; ws.serializeAttachment(eu); this.avisarUsuarios(); break; }
        const x = Number(m.x), y = Number(m.y);
        if (!isFinite(x) || !isFinite(y)) return;
        const novo = !eu.pos;
        eu.pos = { x: Math.round(Math.max(0, Math.min(1600, x))), y: Math.round(Math.max(0, Math.min(1000, y))) };
        ws.serializeAttachment(eu);
        if (novo) this.avisarUsuarios();
        else this.transmitir({ t: "pos", id: eu.id, x: eu.pos.x, y: eu.pos.y }, ws);
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

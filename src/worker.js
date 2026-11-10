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
      this.enviar(ws, { t: "bemvindo", id: eu.id, canais: CANAIS, historico: this.historico() });
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
      case "jogo": // repassa dados do jogo pra todo mundo (menos quem mandou)
        this.transmitir({ t: "jogo", jogo: String(m.jogo || ""), de: eu.id, nome: eu.nome, dados: m.dados }, ws);
        break;
    }
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

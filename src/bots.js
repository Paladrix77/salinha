// Bots da Salinha.
// Para criar um comando novo, adicione uma função em "comandos".
// Ela recebe (args, ctx) e devolve o texto da resposta (ou null para não responder).
//   args = palavras depois do comando  (ex: "!dado 20" -> ["20"])
//   ctx  = { autor, canal, usuarios: [{ id, nome, voz }] }

export const NOME_BOT = "Robô";

const comandos = {
  ajuda: () =>
    "Comandos: !ajuda, !jogos, !tabela, !dado [lados], !moeda, !hora, !quem, !escolher a, b, c, !sorteio",

  jogos: (args, ctx) => {
    const jogos = ctx.futebol?.jogos || [];
    const hora = (d) => new Date(d).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    const linha = (j) => j.estado === "pre" ? `${hora(j.data)} — ${j.casa.nome} x ${j.fora.nome}`
      : `${j.estado === "in" ? "🔴 " + j.relogio : "Fim"} — ${j.casa.nome} ${j.casa.gols} x ${j.fora.gols} ${j.fora.nome}`;
    const aoVivo = jogos.filter((j) => j.estado === "in");
    const proximos = jogos.filter((j) => j.estado === "pre" && new Date(j.data) > Date.now() - 3 * 3600e3).slice(0, 6);
    const ultimos = jogos.filter((j) => j.estado === "post").slice(-4);
    if (!jogos.length) return "Ainda não tenho os jogos. Tenta de novo em um minuto.";
    return ["⚽ Brasileirão", ...aoVivo.map(linha), ...(ultimos.length ? ["Últimos:", ...ultimos.map(linha)] : []), ...(proximos.length ? ["Próximos:", ...proximos.map(linha)] : [])].join("\n");
  },

  tabela: (args, ctx) => {
    const t = ctx.futebol?.tabela || [];
    if (!t.length) return "Ainda não tenho a tabela. Tenta de novo em um minuto.";
    return "🏆 Brasileirão\n" + t.map((l) => `${l.pos}. ${l.nome} — ${l.pts} pts (${l.j}J, SG ${l.sg > 0 ? "+" : ""}${l.sg})`).join("\n");
  },

  dado: (args) => {
    const lados = Math.min(Math.max(parseInt(args[0]) || 6, 2), 1000);
    return `🎲 Caiu ${1 + Math.floor(Math.random() * lados)} (d${lados})`;
  },

  moeda: () => (Math.random() < 0.5 ? "🪙 Cara!" : "🪙 Coroa!"),

  hora: () =>
    "🕒 " + new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }),

  quem: (args, ctx) =>
    `👥 Online (${ctx.usuarios.length}): ${ctx.usuarios.map((u) => u.nome).join(", ")}`,

  escolher: (args) => {
    const opcoes = args.join(" ").split(",").map((s) => s.trim()).filter(Boolean);
    if (opcoes.length < 2) return "Use assim: !escolher pizza, hambúrguer, sushi";
    return `🤔 Eu escolho: ${opcoes[Math.floor(Math.random() * opcoes.length)]}`;
  },

  sorteio: (args, ctx) => {
    if (!ctx.usuarios.length) return null;
    const u = ctx.usuarios[Math.floor(Math.random() * ctx.usuarios.length)];
    return `🎉 Sorteado: ${u.nome}!`;
  },
};

export function executarBot(texto, ctx) {
  if (!texto.startsWith("!")) return null;
  const [cmd, ...args] = texto.slice(1).trim().split(/\s+/);
  const f = comandos[(cmd || "").toLowerCase()];
  return f ? f(args, ctx) : null;
}

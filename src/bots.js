// Bots da Salinha.
// Para criar um comando novo, adicione uma função em "comandos".
// Ela recebe (args, ctx) e devolve o texto da resposta (ou null para não responder).
//   args = palavras depois do comando  (ex: "!dado 20" -> ["20"])
//   ctx  = { autor, canal, usuarios: [{ id, nome, voz }] }

export const NOME_BOT = "Robô";

const comandos = {
  ajuda: () =>
    "Comandos: !ajuda, !dado [lados], !moeda, !hora, !quem, !escolher a, b, c, !sorteio",

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

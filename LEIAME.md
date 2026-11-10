# 🛋️ Salinha: protótipo estilo Discord (custo zero)

O que tem:
- Chat com canais (#geral, #jogos, #bots), com histórico salvo
- Call de voz, webcam e compartilhamento de tela (no PC)
- Bot "Robô" com comandos: `!ajuda`, `!dado 20`, `!moeda`, `!hora`, `!quem`, `!escolher a, b, c`, `!sorteio`
- Aba de jogos com um jogo da velha multiplayer de exemplo

Tudo roda no **plano grátis** da Cloudflare. Voz e vídeo vão direto de um navegador pro outro (WebRTC), sem servidor pago.

## Como publicar (uma vez)
1. Instale o Node.js: https://nodejs.org (versão LTS)
2. Descompacte esta pasta, abra o terminal dentro dela
3. Rode:
   ```
   npx wrangler login
   npx wrangler deploy
   ```
4. Ele mostra o link, algo como `https://salinha.SEU-USUARIO.workers.dev`. Mande pros amigos.

Pra testar no seu PC antes: `npx wrangler dev` e abra http://localhost:8787

Quer outro "servidor" separado (outra turma)? Use `?servidor=nome` no link, ex: `.../?servidor=amigos`.

## Onde mexer
- `src/bots.js`: crie comandos novos do bot (cada comando é uma função)
- `public/jogos/`: coloque seus jogos aqui
- `public/index.html`: lista `JOGOS` no topo do script, adicione o seu jogo nela

## Colocando seu próprio jogo
No HTML do seu jogo, inclua o SDK:
```html
<script src="/jogos/salinha-sdk.js"></script>
<script>
  Salinha.aoFicarPronto(() => console.log("eu sou", Salinha.eu.nome));
  Salinha.enviar({ x: 10, y: 20 });                    // manda pra todo mundo
  Salinha.aoReceber((dados, de) => console.log(de.nome, dados));
</script>
```
Depois adicione em `JOGOS` no index.html: `{ id: "meujogo", nome: "🎮 Meu jogo", url: "/jogos/meujogo.html" }`
e rode `npx wrangler deploy` de novo. Veja `velha.html` como exemplo completo.

## Limites do modo grátis
- Call com vídeo: boa até ~5–6 pessoas (cada um envia vídeo pra cada um). Só voz aguenta ~8–10.
- Algumas redes (certas operadoras de 4G, redes de empresa) bloqueiam conexão direta. Se alguém
  não ouvir/ver os outros, aí precisa de um servidor TURN (próximo passo, se precisar).
- Pra crescer além disso: trocar a parte de voz/vídeo pelo LiveKit, sem mudar o resto.

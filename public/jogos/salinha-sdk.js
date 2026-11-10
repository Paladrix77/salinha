// SDK pra jogos rodarem dentro da Salinha.
// Coloque no seu jogo:  <script src="/jogos/salinha-sdk.js"></script>
//
//   Salinha.aoFicarPronto(() => { ... })        -> já sabe quem você é (Salinha.eu)
//   Salinha.enviar(dados)                       -> manda dados pra todos na sala
//   Salinha.aoReceber((dados, de) => { ... })   -> recebe dados dos outros (de = {id, nome})
//   Salinha.aoMudarUsuarios((lista) => { ... }) -> quem está online
//   Salinha.eu = { id, nome }   Salinha.usuarios = [...]
(function () {
  const ouvintes = [], ouvintesUsuarios = [], prontos = [];
  const S = {
    eu: null,
    usuarios: [],
    enviar(dados) { parent.postMessage({ salinha: true, tipo: "enviar", dados }, "*"); },
    aoReceber(fn) { ouvintes.push(fn); },
    aoMudarUsuarios(fn) { ouvintesUsuarios.push(fn); },
    aoFicarPronto(fn) { if (S.eu) fn(); else prontos.push(fn); },
  };
  addEventListener("message", (e) => {
    const m = e.data;
    if (e.source !== parent || !m || !m.salinha) return;
    if (m.tipo === "info") {
      const primeira = !S.eu;
      S.eu = m.eu;
      S.usuarios = m.usuarios;
      ouvintesUsuarios.forEach((f) => f(S.usuarios));
      if (primeira) prontos.splice(0).forEach((f) => f());
    } else if (m.tipo === "recebido") {
      ouvintes.forEach((f) => f(m.dados, { id: m.de, nome: m.nome }));
    }
  });
  window.Salinha = S;
  parent.postMessage({ salinha: true, tipo: "pronto" }, "*");
})();

// services/processos/agrupamento.js
//
// ONDE O PADRÃO É ENCONTRADO. Módulo PURO: sem banco, sem rede, SEM IA.
//
// ─────────────────────────────────────────────────────────────────────────────
// A DECISÃO MAIS IMPORTANTE DO MOTOR INTEIRO
//
// O caminho fácil seria entregar 500 observações ao modelo e pedir "encontre os
// padrões". É também o caminho que produz regra inventada: o modelo acha padrão
// em ruído, escreve com confiança, e o texto sai convincente o bastante para
// alguém aprovar. Aí a invenção vira regra da empresa - e regra aprovada é lida
// como verdade por todo mundo depois.
//
// Então a divisão é esta, e ela não se negocia:
//
//   O CÓDIGO ENCONTRA E CONTA.  Agrupa por condição, mede o desfecho, calcula a
//                               confiança. Tudo determinístico e conferível.
//   A IA SÓ ESCREVE A FRASE.    Recebe o padrão JÁ ENCONTRADO e os números JÁ
//                               CONTADOS, e devolve isso em português.
//
// É a mesma regra que já vale no chat da Eme com a ancoragem: número vem do
// sistema, prosa vem do modelo. Aqui vale mais ainda, porque o produto é uma
// regra permanente e não uma resposta que alguém lê e esquece.
//
// ─────────────────────────────────────────────────────────────────────────────
// CONDIÇÃO E DESFECHO SÃO COISAS DIFERENTES
//
// O agrupamento é pela CONDIÇÃO (o que era verdade sobre o caso), e a medida é
// o DESFECHO (o que aconteceu). Misturar os dois faria cada observação virar o
// seu próprio grupo, e nenhum padrão apareceria nunca.
//
// Por isso o número cru fica de fora da assinatura: `dias_parado: 6` e
// `dias_parado: 7` são o mesmo caso para efeito de regra, e é a `faixa` que
// entra no lugar. Sem isso, 40 observações viram 40 grupos de 1.

/** Achata um `visto` em pares condição=valor, descartando número cru. */
export function condicoesDe(visto = {}) {
    const out = [];
    for (const [k, v] of Object.entries(visto || {})) {
        if (v == null) continue;
        // Número cru não entra: é o que impede o grupo de existir. A `faixa`
        // que o acompanha é o mesmo fato em linguagem de regra.
        if (typeof v === 'number') continue;
        if (typeof v === 'boolean') { out.push(`${k}=${v ? 'sim' : 'nao'}`); continue; }
        if (typeof v === 'string') {
            const s = v.trim();
            if (s) out.push(`${k}=${s.toLocaleLowerCase('pt-BR')}`);
        }
    }
    return out.sort();
}

/**
 * Confiança a partir dos NÚMEROS, nunca do modelo.
 *
 * É a proporção do desfecho dominante, puxada na direção do cara-ou-coroa
 * quando há poucos casos. Sem esse amortecimento, 3 de 3 daria 100% - e 100%
 * de confiança com três casos é exatamente o tipo de número que faz alguém
 * aprovar uma regra que é coincidência.
 *
 * k=4 e nao 2: com k=2, tres casos unanimes davam 0,80 - numero que PARECE
 * certeza e passaria folgado pelo corte de confianca. So o minimo de evidencia
 * segurava, e depender de uma trava so e como o motor acabaria propondo
 * coincidencia no dia em que alguem afrouxasse a outra.
 *
 * Com k=4:  3/3 -> 0,71    5/5 -> 0,78    10/10 -> 0,86    40/40 -> 0,95
 *           20/40 -> 0,50  (desfecho dividido fica no cara-ou-coroa)
 */
export function confiancaDe(dominantes, total, k = 4) {
    if (!total || total <= 0) return 0;
    return Number(((dominantes + 0.5 * k) / (total + k)).toFixed(3));
}

/**
 * Agrupa observações por condição e mede o desfecho de cada grupo.
 *
 * @returns {Array<{ assinatura, caso_tipo, condicoes, total, desfechos,
 *                   dominante, dominante_n, confianca, observacoes }>}
 */
export function agrupar(observacoes = []) {
    const grupos = new Map();

    for (const o of observacoes) {
        const condicoes = condicoesDe(o.visto);
        if (!condicoes.length) continue;      // sem condição não há o que agrupar

        const assinatura = `${o.caso_tipo}|${condicoes.join('&')}`;
        if (!grupos.has(assinatura)) {
            grupos.set(assinatura, {
                assinatura, caso_tipo: o.caso_tipo, condicoes,
                total: 0, desfechos: {}, observacoes: [],
            });
        }
        const g = grupos.get(assinatura);
        g.total++;
        const r = o.resultado || 'sem_desfecho';
        g.desfechos[r] = (g.desfechos[r] || 0) + 1;
        g.observacoes.push(o);
    }

    return [...grupos.values()].map(g => {
        const [dominante, dominante_n] = Object.entries(g.desfechos)
            .sort((a, b) => b[1] - a[1])[0] || [null, 0];
        return { ...g, dominante, dominante_n, confianca: confiancaDe(dominante_n, g.total) };
    }).sort((a, b) => b.total - a.total);
}

/**
 * Quais grupos merecem virar proposta.
 *
 * Três cortes, e cada um tira um jeito diferente de errar:
 *
 *   evidência    poucos casos é coincidência.
 *   confiança    desfecho dividido não é regra, é a vida sendo variada.
 *   largura      grupo inteiro de um empreendimento só vira regra DAQUELE
 *                empreendimento - a checagem final é do escopo.js, mas cortar
 *                aqui evita gastar chamada de IA com o que não passaria.
 *
 * O corte de largura NÃO descarta: só rebaixa a prioridade. Um padrão local
 * verdadeiro continua valendo como regra local.
 */
export function candidatos(grupos = [], cfg = {}) {
    const minEvid = Number(cfg.min_evidencias) > 0 ? Number(cfg.min_evidencias) : 5;
    const minConf = Number(cfg.min_confianca) > 0 ? Number(cfg.min_confianca) : 0.6;
    const teto = Number(cfg.max_candidatos) > 0 ? Number(cfg.max_candidatos) : 12;

    return grupos
        .filter(g => g.total >= minEvid)
        .filter(g => g.confianca >= minConf)
        // Desfecho sem nome não vira regra: "aconteceu alguma coisa" não é
        // conhecimento, e deixar passar encheria a fila de frase vazia.
        .filter(g => g.dominante && g.dominante !== 'sem_desfecho')
        .sort((a, b) => (b.confianca * b.total) - (a.confianca * a.total))
        // Teto na origem: cada candidato custa uma chamada de IA, e o portão
        // da fila vai cortar de novo lá na frente de qualquer jeito.
        .slice(0, teto);
}

/**
 * O resumo que vai para o modelo escrever a frase.
 *
 * Só números JÁ CONTADOS e condições JÁ ENCONTRADAS. O modelo não recebe
 * observação crua: além de ser dado de caso com escopo, é o que o faria
 * "descobrir" um padrão que a contagem não sustenta.
 */
export function resumoParaRedacao(grupo) {
    return {
        tipo: grupo.caso_tipo,
        condicoes: grupo.condicoes,
        casos: grupo.total,
        desfecho: grupo.dominante,
        desfecho_casos: grupo.dominante_n,
        desfecho_pct: Math.round((grupo.dominante_n / grupo.total) * 100),
        outros_desfechos: Object.entries(grupo.desfechos)
            .filter(([k]) => k !== grupo.dominante)
            .map(([k, n]) => `${k}: ${n}`),
    };
}

export default { condicoesDe, confiancaDe, agrupar, candidatos, resumoParaRedacao };

// services/OfficeAI/anchoringSettings.js
//
// A regra de operação da ANCORAGEM, em tabela (`eme_settings` chave
// `anchoring`, tela Cérebro da Eme > Ancoragem). Mesmo padrão do
// promptRetrieval: leitura com cache curto, vale na hora, sem publicar.
//
// O QUE É CONFIGURÁVEL, E O QUE NÃO É
//
// Configurável: ligar/desligar, o MODO, o limiar de aviso e o teto de tamanho
// do bloco de instrução. São decisões de operação - a pessoa que opera precisa
// poder desligar isto às 2h da manhã se der ruim, sem deploy.
//
// NÃO configurável: o TEXTO da instrução de citação e o formato `{{ref:...}}`.
// Isso é contrato com o resolvedor, não prosa: uma edição bem-intencionada na
// tela quebraria a resolução em silêncio, e o sintoma seria a Eme escrevendo
// reticências no lugar dos números. Mecanismo fica em código; o interruptor
// fica na tela.

import db from '../../models/sequelize/index.js';

export const ANCHORING_DEFAULTS = {
    // Nasce LIGADO em modo suave: a ancoragem só acrescenta (referência que
    // aparece é resolvida), e nada muda para quem não usa referência nenhuma.
    enabled: true,

    // 'suave'   - referência é resolvida; número cru segue pela trava antiga.
    // 'estrito' - além disso, resposta pouco ancorada com dado na mão vira
    //             incidente, para o admin ver o padrão antes de apertar de vez.
    //
    // Começa em 'suave' de propósito: trocar uma heurística por outra sem
    // medir a adesão do modelo seria repetir o erro que a ancoragem corrige.
    modo: 'suave',

    // Abaixo disto, com dado no turno, o modo estrito reclama. 0.8 = quatro em
    // cada cinco números da resposta vieram por referência.
    min_taxa: 0.8,

    // Teto de itens citáveis que entram no prompt. Acima disso o custo de
    // contexto passa a pesar mais que o ganho, e o modelo começa a errar o id.
    max_citacoes: 400,
};

const MODOS = ['suave', 'estrito'];

let _cfg = null;
let _cfgAt = 0;
const TTL = 30 * 1000;

export function invalidateAnchoringCache() { _cfg = null; _cfgAt = 0; }

export async function anchoringSettings() {
    if (_cfg && Date.now() - _cfgAt < TTL) return _cfg;
    let extra = null;
    try {
        const row = await db.EmeSetting.findOne({ where: { key: 'anchoring' }, attributes: ['value'], raw: true });
        extra = row?.value && typeof row.value === 'object' ? row.value : null;
    } catch {
        // Sem a tabela ainda (primeiro boot): padrões. A ancoragem nunca pode
        // ser motivo de o chat não responder.
    }
    _cfg = { ...ANCHORING_DEFAULTS, ...(extra || {}) };
    _cfgAt = Date.now();
    return _cfg;
}

/** Valida e normaliza o que a tela manda salvar. */
export function sanitizeAnchoringSettings(input = {}) {
    const num = (v, d, min, max) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : d;
    };
    const D = ANCHORING_DEFAULTS;
    return {
        enabled: typeof input.enabled === 'boolean' ? input.enabled : D.enabled,
        modo: MODOS.includes(input.modo) ? input.modo : D.modo,
        min_taxa: num(input.min_taxa, D.min_taxa, 0, 1),
        max_citacoes: num(input.max_citacoes, D.max_citacoes, 20, 2000),
    };
}

/**
 * A instrução de citação que entra no system prompt.
 *
 * Mora em código, e não nos blocos do cérebro, por dois motivos concretos:
 *
 *   1. É CONTRATO, não estilo. O `{{ref:...}}` precisa bater exatamente com o
 *      resolvedor; uma edição na tela quebraria a resolução em silêncio.
 *   2. Bloco do cérebro só chega ao prompt quando há versão PUBLICADA. Como
 *      instrução em código, ela vale desde o primeiro turno, com ou sem
 *      cérebro publicado - que é o que faz a ancoragem existir de verdade em
 *      vez de depender de alguém lembrar de republicar.
 *
 * Curta de propósito: ela entra em TODO turno que trouxe dado, e cada linha
 * aqui é orçamento que some das outras instruções.
 */
export const BLOCO_ANCORAGEM = `
## Como citar número e nome vindos de consulta (OBRIGATÓRIO)

Todo número e todo nome que vier do resultado de uma consulta você escreve como
REFERÊNCIA, nunca digitado:

- \`{{ref:r3.vendas}}\`  - a célula \`vendas\` da linha de \`ref\` "r3"
- \`{{ref:c1.nome}}\` e \`{{ref:c1.valor}}\` - a categoria c1 de \`citacoes_categorias\`
- \`{{ref:v1}}\` - um total ou indicador de \`citacoes_valores\`

O sistema troca a referência pelo valor real, já formatado, antes de a pessoa
ler. Use SOMENTE os \`ref\` que vieram no resultado: referência inventada não
resolve e a frase sai furada.

Para citar nome e número do MESMO item, use o MESMO \`ref\` nos dois
(\`{{ref:r3.empreendimento}}\` com \`{{ref:r3.vendas}}\`) - é isso que impede
colar o número de um no nome de outro.

NÃO use referência para o que não veio de consulta: horário que você propôs,
prazo que a pessoa disse, número que ela escreveu na pergunta. Isso você escreve
normalmente.
`.trim();

export default {
    anchoringSettings,
    sanitizeAnchoringSettings,
    invalidateAnchoringCache,
    ANCHORING_DEFAULTS,
    BLOCO_ANCORAGEM,
};

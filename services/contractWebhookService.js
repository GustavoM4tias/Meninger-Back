// services/contractWebhookService.js
//
// Porta de entrada do webhook CONTRATOS_IA do CV: o repasse entrou em
// "Analise Contratos" e o CV avisa na hora, em vez de a gente varrer a base de
// tempos em tempos.
//
// Três garantias que esta camada precisa dar, todas por causa de como o CV se
// comporta de verdade:
//
//   1. NÃO CONFIAR NO CORPO. O CV manda o que quer, e o endereço é público.
//      O único dado que aproveitamos do corpo é o id do repasse; TUDO o mais
//      (situação, reserva, cliente) é relido do CV. Chamada forjada, no pior
//      caso, manda analisar um repasse que de fato está na etapa — que é
//      exatamente o que o job faria sozinho.
//   2. NÃO REPETIR — MAS SEM JANELA DE TEMPO. Chamada duplicada enquanto a
//      análise roda é barrada pelo registro de "em voo". Depois que ela termina
//      bem, o próprio CV faz a dedupe: o repasse SAI de "Analise Contratos", e
//      a chamada seguinte não acha nada para analisar. Ignorar por tempo, como
//      eu tinha feito, quebraria o caso mais comum da operação: contrato
//      reprovado, corrigido e devolvido para reanálise em poucos minutos seria
//      descartado calado.
//   3. RESPONDER RÁPIDO. O CV corta a conexão e conta como falha se demorar; a
//      análise leva minutos. Por isso o controller responde 200 na hora e este
//      serviço roda solto, deixando rastro em contract_validator_runs.

import crypto from 'crypto';
import ContractAnalysisService from './contractAnalysisService.js';


const emVoo = new Set();          // idrepasse sendo analisado agora

const service = new ContractAnalysisService();

async function db() {
    const { default: models } = await import('../models/sequelize/index.js');
    return models;
}

/**
 * Configuração do webhook, criada na primeira leitura. Nasce sozinha para não
 * depender de script manual nem de variável nova no painel do Railway.
 */
export async function obterConfig() {
    const models = await db();
    const [linha] = await models.ContractWebhookSetting.findOrCreate({
        where: { id: 1 },
        defaults: { id: 1, token: crypto.randomBytes(24).toString('hex'), active: true },
    });
    return linha;
}

/**
 * O endereço inteiro para colar no campo "Endereço" do painel do CV.
 *
 * A base vem da própria requisição quando existe uma, e só cai em
 * PUBLIC_API_URL como reserva: depender de variável de ambiente para montar
 * isto daria endereço pela metade justamente onde ninguém confere — o campo é
 * colado uma vez e some da vista. O router mora em /api/contracts (server.js).
 */
export async function montarEndereco(baseDaRequisicao = null) {
    const linha = await obterConfig();
    const base = (baseDaRequisicao || process.env.PUBLIC_API_URL || '').replace(/\/$/, '');
    return `${base}/api/contracts/webhook/${linha.token}`;
}

/** Confere o segredo da URL em tempo constante. */
export async function tokenConfere(recebido) {
    const linha = await obterConfig();
    if (!linha.active) return false;

    const a = Buffer.from(String(recebido || ''));
    const b = Buffer.from(String(linha.token));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * O id do repasse dentro do corpo do CV. O painel não documenta o formato e
 * ele varia por funcionalidade, então aceitamos os nomes conhecidos em vez de
 * apostar em um só — errar aqui é o webhook virar 400 silencioso.
 */
export function extrairIdRepasse(corpo = {}) {
    const candidatos = [
        corpo.idrepasse, corpo.idRepasse, corpo.ID, corpo.id,
        corpo.repasse?.idrepasse, corpo.repasse?.ID, corpo.repasse?.id,
        corpo.dados?.idrepasse, corpo.dados?.ID,
    ];
    for (const c of candidatos) {
        const n = Number(c);
        if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
}

/** Registra que o CV chamou — mesmo quando a chamada não vira análise. */
export async function registrarChamada(idrepasse) {
    try {
        const linha = await obterConfig();
        await linha.update({
            last_call_at: new Date(),
            last_idrepasse: idrepasse || null,
            calls_total: (linha.calls_total || 0) + 1,
        });
    } catch (error) {
        console.warn('[CONTRATOS_IA] não consegui registrar a chamada:', error.message);
    }
}

/**
 * Analisa UM repasse por causa do webhook. Devolve o desfecho para o log; o
 * chamador não espera por isso.
 */
export async function processarWebhook(idrepasse, origem = 'webhook') {
    const chave = Number(idrepasse);

    // Chamada duplicada ENQUANTO a análise roda é a única que precisa ser
    // barrada aqui. Repetição depois que ela termina se resolve sozinha: a
    // análise bem-sucedida tira o repasse de "Analise Contratos", e a chamada
    // seguinte não acha nada para fazer.
    if (emVoo.has(chave)) {
        console.log(`[CONTRATOS_IA] repasse ${chave} já está em análise; ignorando a chamada repetida.`);
        return { ignorado: 'em_voo' };
    }

    emVoo.add(chave);
    try {
        return await service.analisarPorId(chave, origem);
    } finally {
        emVoo.delete(chave);
    }
}

export default { obterConfig, montarEndereco, tokenConfere, extrairIdRepasse, registrarChamada, processarWebhook };

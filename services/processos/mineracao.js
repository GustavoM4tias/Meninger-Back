// services/processos/mineracao.js
//
// DE OBSERVAÇÃO A PROPOSTA. A única parte do motor que fala com a IA.
//
// ─────────────────────────────────────────────────────────────────────────────
// O QUE A IA FAZ AQUI, E O QUE ELA NÃO FAZ
//
// FAZ:      pega um padrão JÁ ENCONTRADO pelo código, com os números JÁ
//           CONTADOS, e escreve em português a frase que vira regra.
// NÃO FAZ:  encontrar padrão, calcular confiança, decidir alcance, ver
//           observação crua, gravar coisa nenhuma.
//
// A separação é o que impede regra inventada. Se o modelo olhasse as 500
// observações e "achasse os padrões", ele acharia padrão em ruído, escreveria
// com confiança, e o texto sairia convincente o bastante para alguém aprovar -
// virando verdade da empresa a partir de coincidência.
//
// Em compensação, quando a IA está fora do ar o motor NÃO para: cai para uma
// frase montada por template a partir dos mesmos números. Fica mais seca e
// serve igual, porque a informação nunca esteve no modelo.
//
// ─────────────────────────────────────────────────────────────────────────────
// A MINERAÇÃO NUNCA GRAVA REGRA
//
// Ela chama `registrarProposta`, que passa pelo portão e, no melhor caso,
// coloca um item na fila. Quem transforma proposta em regra é uma pessoa na
// tela. Em nenhum degrau de autonomia isso muda: 'decidir' dá à Eme o direito
// de escolher o caminho DENTRO de uma regra aprovada, nunca o de escrever a
// regra.

import { json as gwJson } from '../ai/gateway.js';
import { agrupar, candidatos, resumoParaRedacao } from './agrupamento.js';
import { coletar } from './observadores/coletores.js';
import {
    getSettings, registrarObservacao, observacoesDe, registrarProposta, listarProcessos,
} from './processoService.js';

/**
 * Frase montada SEM IA, a partir dos mesmos números.
 *
 * É o piso do motor, e existe para que "o Gemini caiu" nunca vire "o
 * aprendizado parou". Seca de propósito: a informação está nos números, e uma
 * frase seca e correta vale mais que uma bonita e inventada.
 */
export function fraseDeTemplate(resumo) {
    const cond = resumo.condicoes
        .map(c => c.replace(/_/g, ' ').replace('=', ': '))
        .join('; ');
    return `Quando ${cond} (${resumo.tipo}), o desfecho foi "${resumo.desfecho}" em ` +
        `${resumo.desfecho_casos} de ${resumo.casos} casos (${resumo.desfecho_pct}%).`;
}

const INSTRUCAO = `Você escreve REGRAS DE PROCESSO para uma incorporadora imobiliária, em português do Brasil.

Recebe um padrão que JÁ FOI ENCONTRADO e JÁ FOI CONTADO por um sistema. Seu trabalho é só redigir.

REGRAS DA REDAÇÃO:
- Uma frase, no máximo duas. Direta, no presente, dizendo o que a empresa faz ou deve fazer.
- Use SOMENTE os números que vieram no resumo. Não estime, não arredonde para cima, não acrescente nenhum número novo.
- Fale de PAPÉIS ("o corretor responsável", "a equipe de repasse"), nunca de pessoas, nomes, CPF, telefone ou e-mail.
- Se o desfecho dominante não chega a 100%, a frase não pode soar absoluta: use "costuma", "na maioria dos casos".
- Não invente causa. O sistema contou uma associação, não provou um porquê.
- Sem preâmbulo, sem explicar o que você está fazendo.

Responda APENAS com JSON: { "regra": "..." }`;

/**
 * Redige a regra candidata. Cai no template quando a IA não responde ou
 * devolve algo inaproveitável - inclusive quando devolve texto longo demais,
 * que costuma ser o modelo explicando em vez de redigindo.
 */
export async function redigir(resumo) {
    const prompt = `${INSTRUCAO}

PADRÃO ENCONTRADO:
${JSON.stringify(resumo, null, 2)}`;

    try {
        const r = await gwJson('processos', prompt, { maxSaida: 300, temperatura: 0.2 });
        const texto = String(r?.regra || '').trim();
        if (texto.length >= 20 && texto.length <= 500) return { texto, por: 'ia' };
    } catch (err) {
        console.warn('[processos/mineracao] redação pela IA falhou:', err?.message);
    }
    return { texto: fraseDeTemplate(resumo), por: 'template' };
}

/**
 * Uma passada completa de um processo: coleta, grava o que é novo, agrupa,
 * e propõe.
 *
 * `seco: true` NÃO GRAVA NADA e devolve o que faria. Existe porque os
 * coletores leem tabelas do CV cuja semântica ninguém pode conferir a não ser
 * olhando dado real - e a forma responsável de ligar isso é ver a saída antes
 * de deixá-la escrever.
 */
export async function minerarProcesso(processo, { seco = false, agora = new Date() } = {}) {
    const cfg = await getSettings();
    const resumo = {
        processo: processo.key,
        coletadas: 0, novas: 0, grupos: 0, candidatos: 0,
        propostas: [], erro: null,
    };

    const { observacoes, erro } = await coletar(processo, { cfg, agora });
    resumo.coletadas = observacoes.length;
    if (erro) resumo.erro = erro;

    // Idempotência: o episódio já registrado não entra de novo. Sem isto, o
    // mesmo caso inflaria a evidência a cada rodada e um lead só passaria
    // sozinho pelo portão.
    const jaVistas = new Set(
        (await observacoesDe(processo.key, { limite: 2000 })).map(o => o.caso_ref),
    );
    const novas = observacoes.filter(o => !jaVistas.has(o.caso_ref));
    resumo.novas = novas.length;

    if (!seco) {
        for (const o of novas) await registrarObservacao(processo.key, o);
    }

    // O agrupamento roda sobre TUDO o que já foi observado, não só o novo: o
    // padrão se forma ao longo de semanas, e olhar só a rodada do dia nunca
    // acumularia evidência suficiente para passar no portão.
    const todas = seco
        ? [...novas, ...(await observacoesDe(processo.key, { limite: 2000 }))]
        : await observacoesDe(processo.key, { limite: 2000 });

    const grupos = agrupar(todas);
    resumo.grupos = grupos.length;

    const escolhidos = candidatos(grupos, cfg);
    resumo.candidatos = escolhidos.length;

    for (const g of escolhidos) {
        const r = resumoParaRedacao(g);
        const { texto, por } = await redigir(r);

        if (seco) {
            resumo.propostas.push({ texto, por, casos: g.total, confianca: g.confianca, classe: '(seco)' });
            continue;
        }

        const v = await registrarProposta({
            processo_key: processo.key,
            texto,
            confianca: g.confianca,
            observacoes: g.observacoes,
        });
        resumo.propostas.push({ texto, por, casos: g.total, confianca: g.confianca, classe: v.classe, motivo: v.motivo });
    }

    return resumo;
}

/**
 * Todos os processos, numa passada.
 *
 * Processo DESLIGADO fica de fora; processo em 'observar' NÃO: observar é o
 * primeiro degrau e ele existe justamente para isto. O que o degrau controla é
 * se a proposta APARECE para alguém, não se o motor aprende.
 */
export async function minerarTudo({ seco = false, agora = new Date() } = {}) {
    const cfg = await getSettings();
    if (!cfg.mineracao_enabled && !seco) {
        return { rodou: false, motivo: 'Mineração desligada nos ajustes.', processos: [] };
    }

    const processos = (await listarProcessos()).filter(p => p.enabled);
    const out = [];
    for (const p of processos) {
        out.push(await minerarProcesso(p, { seco, agora }));
    }

    const total = out.reduce((s, r) => s + r.propostas.length, 0);
    if (!seco) console.log(`[Processos] mineração: ${processos.length} processo(s), ${total} proposta(s).`);
    return { rodou: true, processos: out };
}

export default { minerarProcesso, minerarTudo, redigir, fraseDeTemplate };

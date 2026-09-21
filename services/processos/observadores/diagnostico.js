// services/processos/observadores/diagnostico.js
//
// OS COLETORES ESTÃO LENDO CERTO?
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE ISTO EXISTE
//
// Os coletores derivam episódio de CARIMBO DE DATA nas tabelas do CV:
// `ultima_data_conversao` seria quando o lead andou, `data_contrato_liberado`
// seria quando o repasse travou. Essas leituras são suposições sobre o
// significado de colunas que outro sistema preenche - e suposição sobre dado
// alheio é o tipo de coisa que só o dado real confirma.
//
// A alternativa era "rode o ensaio e olhe no olho". Não serve: olhar cem
// linhas de saída e julgar se fazem sentido é trabalho que ninguém faz duas
// vezes, e a primeira vez a pessoa faz com pressa.
//
// Então aqui o sistema confere as próprias premissas e diz, em português, qual
// está de pé e qual não está.
//
// ─────────────────────────────────────────────────────────────────────────────
// A CHECAGEM QUE MAIS IMPORTA É A DO ESCOPO
//
// Se o empreendimento da linha do CV não casar com a tabela `enterprises`, a
// observação nasce SEM escopo. E observação sem escopo é fail-closed no resto
// do motor: ela nunca vira evidência de nada.
//
// O sintoma disso é o pior que existe - "a fila nunca tem nada" - porque é
// indistinguível de "ainda não há padrão". Alguém esperaria meses achando que
// o motor está aprendendo devagar, quando ele não está aprendendo.

import { Op } from 'sequelize';
import db from '../../../models/sequelize/index.js';
import { resolverEscopo, tamanhoDoRegistro } from './escopoLookup.js';

const DIA = 86400000;
const AMOSTRA = 500;

// ── Julgamento (puro, testável) ──────────────────────────────────────────────

export const VEREDITOS = ['ok', 'atencao', 'falha'];

/**
 * Cobertura de uma coluna: quantos por cento das linhas a têm preenchida.
 *
 * Os cortes são generosos de propósito. O objetivo não é exigir dado perfeito
 * (o CV é de outra gente e sempre terá buraco), é separar "tem buraco" de
 * "a coluna não significa o que a gente achou".
 */
export function julgarCobertura(preenchidos, total, { bom = 30, ruim = 5 } = {}) {
    if (!total) return { veredito: 'falha', pct: 0, motivo: 'Nenhuma linha no período.' };
    const pct = Math.round((preenchidos / total) * 100);
    if (pct >= bom) return { veredito: 'ok', pct, motivo: '' };
    if (pct >= ruim) return { veredito: 'atencao', pct, motivo: 'Cobertura baixa.' };
    return { veredito: 'falha', pct, motivo: 'Praticamente nenhuma linha tem este campo.' };
}

/** O pior veredito de uma lista manda no conjunto. */
export function piorVeredito(checagens = []) {
    if (checagens.some(c => c.veredito === 'falha')) return 'falha';
    if (checagens.some(c => c.veredito === 'atencao')) return 'atencao';
    return checagens.length ? 'ok' : 'atencao';
}

/**
 * Uma frase que diz O QUE FAZER, não só o que foi medido.
 *
 * Diagnóstico que informa e não orienta vira um painel que a pessoa lê uma vez
 * e nunca mais - e o defeito continua lá.
 */
export function resumoGeral(checagens = []) {
    const pior = piorVeredito(checagens);
    const ruins = checagens.filter(c => c.veredito === 'falha');

    if (pior === 'falha') {
        return {
            veredito: 'falha',
            texto: `${ruins.length} premissa(s) do motor não se confirmam nos seus dados: ${ruins.map(c => c.titulo).join('; ')}. Enquanto isso não for corrigido, esses coletores vão gravar pouca coisa ou coisa errada - e o sintoma será uma fila que nunca enche.`,
        };
    }
    if (pior === 'atencao') {
        return {
            veredito: 'atencao',
            texto: 'As premissas se confirmam, mas com cobertura menor do que o ideal. O motor vai funcionar e aprender mais devagar do que poderia.',
        };
    }
    return {
        veredito: 'ok',
        texto: 'As premissas dos coletores batem com os seus dados. Dá para ligar a mineração e confiar no que ela gravar.',
    };
}

// ── Checagens contra o dado real ─────────────────────────────────────────────

const check = (chave, titulo, veredito, numero, texto, oque_fazer = null) =>
    ({ chave, titulo, veredito, numero, texto, oque_fazer });

/**
 * A mais importante: o empreendimento da linha do CV casa com o registro?
 *
 * Falha aqui é silenciosa e cara: as observações nascem sem escopo, nunca
 * viram evidência, e a tela mostra uma fila vazia que parece normal.
 */
async function checarEscopo(desde) {
    const registro = await tamanhoDoRegistro();
    if (!registro) {
        return [check('escopo_registro', 'Registro de empreendimentos', 'falha', 0,
            'A tabela `enterprises` está vazia. NENHUMA observação vai conseguir carregar escopo, e por isso nenhuma vai virar evidência.',
            'Rode a sincronização em Configurações > Empresas antes de ligar a mineração.')];
    }

    const out = [check('escopo_registro', 'Registro de empreendimentos', 'ok', registro,
        `${registro} empreendimento(s) no registro unificado.`)];

    // Amostra real: pega o empreendimento como as tabelas guardam e tenta
    // resolver. É a única forma de saber se o pareamento por nome funciona.
    const fontes = [
        ['leads', db.Lead, 'empreendimento', { data_cad: { [Op.gte]: desde } }],
        ['reservas', db.Reserva, 'empreendimento', { updated_at: { [Op.gte]: desde } }],
        ['repasses', db.Repasse, 'empreendimento', { data_status_repasse: { [Op.gte]: desde } }],
    ];

    for (const [nome, model, campo, where] of fontes) {
        try {
            const rows = await model.findAll({ where, attributes: [campo], limit: AMOSTRA, raw: true });
            if (!rows.length) {
                out.push(check(`escopo_${nome}`, `Pareamento de empreendimento (${nome})`, 'atencao', 0,
                    'Nenhuma linha no período para conferir.'));
                continue;
            }

            let casaram = 0;
            for (const r of rows) {
                const e = await resolverEscopo(r[campo]);
                if (e.cv_ids.length || e.erp_ids.length) casaram++;
            }

            const j = julgarCobertura(casaram, rows.length, { bom: 80, ruim: 40 });
            out.push(check(`escopo_${nome}`, `Pareamento de empreendimento (${nome})`, j.veredito, j.pct,
                `${j.pct}% das linhas casaram com um empreendimento do registro (${casaram} de ${rows.length}).`,
                j.veredito === 'ok' ? null
                    : 'As que não casam geram observação SEM escopo, e observação sem escopo nunca vira evidência. Confira os nomes em Configurações > Empresas.'));
        } catch (err) {
            out.push(check(`escopo_${nome}`, `Pareamento de empreendimento (${nome})`, 'falha', 0,
                `Não deu para conferir: ${err.message}`));
        }
    }
    return out;
}

/** Leads: `ultima_data_conversao` é mesmo o carimbo de "o lead andou"? */
async function checarLeads(desde) {
    const [total, comConversao, perdidos] = await Promise.all([
        db.Lead.count({ where: { data_cad: { [Op.gte]: desde } } }),
        db.Lead.count({ where: { data_cad: { [Op.gte]: desde }, ultima_data_conversao: { [Op.ne]: null } } }),
        db.Lead.count({ where: { data_cad: { [Op.gte]: desde }, situacao_nome: { [Op.iRegexp]: 'perdid|descart|cancel|inativ' } } }),
    ]);

    const j = julgarCobertura(comConversao, total, { bom: 20, ruim: 3 });
    const out = [
        check('lead_conversao', 'Carimbo de movimento do lead', j.veredito, j.pct,
            `${j.pct}% dos leads têm "ultima_data_conversao" preenchida (${comConversao} de ${total}).`,
            j.veredito === 'ok' ? null
                : 'O coletor de lead usa essa coluna como "quando o lead andou". Se ela quase nunca vem preenchida, ele não vai enxergar episódio de destrave - e esse processo ficará em branco.'),
    ];

    const jp = julgarCobertura(perdidos, total, { bom: 5, ruim: 1 });
    out.push(check('lead_perda', 'Situações de perda reconhecidas', jp.veredito, jp.pct,
        `${jp.pct}% dos leads estão em situação que o coletor lê como perdida (${perdidos} de ${total}).`,
        jp.veredito === 'ok' ? null
            : 'O coletor procura "perdido, descartado, cancelado, inativo" no nome da situação. Se a sua operação usa outras palavras, o episódio de perda nunca é observado.'));

    return out;
}

/** Reservas: o par data_reserva -> data_contrato existe de verdade? */
async function checarReservas(desde) {
    const [total, comContrato, canceladas] = await Promise.all([
        db.Reserva.count({ where: { data_reserva: { [Op.gte]: desde } } }),
        db.Reserva.count({ where: { data_reserva: { [Op.gte]: desde }, data_contrato: { [Op.ne]: null } } }),
        db.Reserva.count({ where: { data_reserva: { [Op.gte]: desde }, status_reserva: { [Op.iRegexp]: 'cancel|distrat|desist' } } }),
    ]);

    const j = julgarCobertura(comContrato + canceladas, total, { bom: 25, ruim: 5 });
    return [check('reserva_desfecho', 'Reservas com desfecho', j.veredito, j.pct,
        `${j.pct}% das reservas do período já fecharam (${comContrato} viraram contrato, ${canceladas} caíram, de ${total}).`,
        j.veredito === 'ok' ? null
            : 'O coletor só observa reserva com DESFECHO: sem contrato e sem cancelamento, não há episódio. Poucas fechadas significa pouca matéria-prima, não defeito.')];
}

/** Repasses: existe o par travou/destravou, e o SLA vem preenchido? */
async function checarRepasses(desde) {
    const [total, comPar, comSla] = await Promise.all([
        db.Repasse.count({ where: { data_status_repasse: { [Op.gte]: desde } } }),
        db.Repasse.count({
            where: {
                data_status_repasse: { [Op.gte]: desde },
                data_contrato_liberado: { [Op.ne]: null },
            },
        }),
        db.Repasse.count({
            where: { data_status_repasse: { [Op.gte]: desde }, sla_prazo_repasse: { [Op.gt]: 0 } },
        }),
    ]);

    const j = julgarCobertura(comPar, total, { bom: 30, ruim: 5 });
    const out = [
        check('repasse_par', 'Carimbo de travamento do repasse', j.veredito, j.pct,
            `${j.pct}% dos repasses têm "data_contrato_liberado" (${comPar} de ${total}).`,
            j.veredito === 'ok' ? null
                : 'O coletor usa essa coluna como "quando o repasse travou". Sem ela não há episódio de destrave, e esse processo fica em branco.'),
    ];

    const js = julgarCobertura(comSla, total, { bom: 40, ruim: 10 });
    out.push(check('repasse_sla', 'SLA do repasse', js.veredito, js.pct,
        `${js.pct}% têm prazo de SLA próprio (${comSla} de ${total}).`,
        js.veredito === 'ok' ? null
            : 'Sem SLA na linha, o coletor cai no prazo padrão do módulo. Funciona, mas pode chamar de atraso o que estava dentro do combinado daquele caso.'));

    return out;
}

/** Performance: há corretor com histórico bastante para ter média própria? */
async function checarPerformance(desde) {
    try {
        const rows = await db.Lead.findAll({
            where: { data_cad: { [Op.gte]: desde } },
            attributes: ['corretor', 'data_cad'],
            limit: 8000,
            raw: true,
        });

        const porCorretor = new Map();
        for (const r of rows) {
            const id = r.corretor?.idcorretor ?? r.corretor?.id ?? null;
            if (id == null) continue;
            const d = new Date(r.data_cad);
            if (Number.isNaN(d.getTime())) continue;
            const dom = new Date(d);
            dom.setUTCDate(dom.getUTCDate() - dom.getUTCDay());
            if (!porCorretor.has(id)) porCorretor.set(id, new Map());
            const s = porCorretor.get(id);
            const k = dom.toISOString().slice(0, 10);
            s.set(k, (s.get(k) || 0) + 1);
        }

        // Precisa de 4 semanas com pelo menos 3 leads para ter média própria.
        const aptos = [...porCorretor.values()]
            .filter(sem => [...sem.values()].filter(n => n >= 3).length >= 4).length;

        const j = julgarCobertura(aptos, porCorretor.size || 1, { bom: 30, ruim: 10 });
        return [check('performance_base', 'Corretores com histórico próprio', j.veredito, aptos,
            `${aptos} de ${porCorretor.size} corretor(es) têm 4+ semanas com volume para formar média própria.`,
            j.veredito === 'ok' ? null
                : 'O coletor compara cada corretor com a média DELE, não com o melhor do time. Sem histórico próprio ele não gera episódio - e é o certo: opinião sobre alguém com base em duas semanas não vale nada.')];
    } catch (err) {
        return [check('performance_base', 'Corretores com histórico próprio', 'falha', 0,
            `Não deu para conferir: ${err.message}`)];
    }
}

/**
 * Roda tudo. Nunca lança: uma checagem que falha vira um item 'falha' com a
 * mensagem, em vez de derrubar o diagnóstico inteiro - o ponto é justamente
 * listar o que não está de pé.
 */
export async function rodarDiagnostico({ dias = 90 } = {}) {
    const desde = new Date(Date.now() - Math.min(365, Math.max(7, Number(dias) || 90)) * DIA);
    const grupos = [];

    const passo = async (titulo, fn) => {
        try { grupos.push({ titulo, checagens: await fn(desde) }); }
        catch (err) {
            grupos.push({
                titulo,
                checagens: [check('erro', titulo, 'falha', 0, `Não deu para conferir: ${err.message}`)],
            });
        }
    };

    await passo('Escopo (o mais importante)', checarEscopo);
    await passo('Lead parado no funil', checarLeads);
    await passo('Reserva até contrato', checarReservas);
    await passo('Repasse e pendências', checarRepasses);
    await passo('Performance do time', checarPerformance);

    const todas = grupos.flatMap(g => g.checagens);
    return { periodo_dias: dias, grupos, resumo: resumoGeral(todas) };
}

export default { rodarDiagnostico, julgarCobertura, piorVeredito, resumoGeral, VEREDITOS };

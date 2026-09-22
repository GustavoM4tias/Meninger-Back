// services/processos/observadores/coletores.js
//
// DE ONDE SAI O COMBUSTÍVEL DO MOTOR.
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE ISTO NÃO ENTRA NOS SCHEDULERS QUE JÁ EXISTEM
//
// O caminho óbvio era pendurar uma chamada de observação dentro do
// leadCvScheduler, do reservaCvScheduler e do repasseCvScheduler. Três razões
// para não fazer isso:
//
//   1. São fluxos de PRODUÇÃO que funcionam. Um erro do motor de processos
//      derrubaria a sincronização do CV, que é infraestrutura de verdade.
//   2. Ficaria espalhado em três arquivos com donos diferentes, e a quarta
//      integração esqueceria o escopo - que é justamente a parte que não pode
//      ser esquecida.
//   3. Não seria configurável. Aqui o `gatilho.fonte` de cada processo diz qual
//      coletor usar, e isso é dado na tela.
//
// Então o coletor LÊ as mesmas tabelas que aqueles schedulers preenchem, na
// sua própria passada. Custa uma consulta a mais e não toca em nada que roda.
//
// ─────────────────────────────────────────────────────────────────────────────
// O CV GUARDA ESTADO, NÃO HISTÓRICO
//
// Não existe log de "este lead estava parado e destravou". O que existe são
// CARIMBOS DE DATA na própria linha, e é deles que o episódio é derivado:
// `data_cad` até `ultima_data_conversao` é exatamente "quanto tempo ficou
// antes de andar". O marco vira a chave estável do episódio, e por isso rodar
// o coletor de novo não duplica nada.
//
// A consequência honesta: o motor enxerga o ÚLTIMO episódio de cada caso, não
// todos. É menos do que um log daria, e é o que dá para fazer sem instrumentar
// o CV inteiro - que seria um projeto à parte, no sistema de outra pessoa.

import { Op } from 'sequelize';
import db from '../../../models/sequelize/index.js';
import { resolverEscopo } from './escopoLookup.js';
import {
    episodioDeLead, episodioDeLeadPerdido, episodioDeReserva,
    episodioDeRepasse, episodioDePerformance, PADROES,
} from './episodios.js';

const DIA = 86400000;

/** Teto por passada. Motor de aprendizado não pode virar carga de banco. */
const LIMITE = 3000;

const PERDIDO = /perdid|descart|cancel|sem interesse|inativ/i;

/**
 * Leads: o tempo entre o cadastro e o primeiro movimento real.
 *
 * `ultima_data_conversao` é o carimbo de quando o lead ANDOU. Para os que
 * morreram, o marco é `updated_at` com situação terminal - imperfeito, e por
 * isso a perda só é observada quando a situação diz claramente que acabou.
 */
async function coletarLeads({ janela, cfg, agora }) {
    const desde = new Date(agora.getTime() - janela * DIA);
    const rows = await db.Lead.findAll({
        where: {
            [Op.or]: [
                { ultima_data_conversao: { [Op.gte]: desde } },
                { updated_at: { [Op.gte]: desde } },
            ],
        },
        attributes: [
            'idlead', 'data_cad', 'ultima_data_conversao', 'situacao_nome',
            'empreendimento', 'corretor', 'cidade', 'qtde_reservas_associadas',
            'motivo_cancelamento', 'updated_at',
        ],
        limit: LIMITE,
        raw: true,
    });

    const out = [];
    for (const r of rows) {
        const escopo = await resolverEscopo(r.empreendimento);
        const perdido = PERDIDO.test(r.situacao_nome || '');

        const base = {
            id: r.idlead,
            criado_em: r.data_cad,
            ultimo_contato_em: null,        // o CV não expõe; o marco é o cadastro
            situacao: r.situacao_nome,
            teve_reserva: Number(r.qtde_reservas_associadas) > 0,
            escopo,
        };

        // Um lead que andou: destrave. Um que morreu parado: perda. Nunca os
        // dois, senão o mesmo caso contaria duas vezes na evidência.
        if (!perdido && r.ultima_data_conversao) {
            const e = episodioDeLead({ ...base, destravado_em: r.ultima_data_conversao }, { cfg, agora });
            if (e) out.push(e);
        } else if (perdido) {
            const e = episodioDeLeadPerdido({
                ...base,
                perdido_em: r.updated_at,
                motivo_perda: r.motivo_cancelamento || null,
            }, { cfg, agora });
            if (e) out.push(e);
        }
    }
    return out;
}

/** Reservas: quanto tempo da reserva até o contrato, e o que aconteceu. */
async function coletarReservas({ janela, cfg, agora }) {
    const desde = new Date(agora.getTime() - janela * DIA);
    const rows = await db.Reserva.findAll({
        where: {
            [Op.or]: [
                { data_contrato: { [Op.gte]: desde } },
                { data_venda: { [Op.gte]: desde } },
                { updated_at: { [Op.gte]: desde } },
            ],
        },
        attributes: [
            'idreserva', 'data_reserva', 'data_contrato', 'data_venda',
            'status_reserva', 'empreendimento', 'idempreendimento_cv', 'etapa', 'updated_at',
        ],
        limit: LIMITE,
        raw: true,
    });

    const out = [];
    for (const r of rows) {
        // O episódio fecha quando há contrato OU quando a reserva caiu. Reserva
        // ainda em andamento não ensina nada: não tem desfecho.
        const caiu = /cancel|distrat|desist/i.test(r.status_reserva || '');
        const fim = r.data_contrato || (caiu ? r.updated_at : null);
        if (!fim) continue;

        // Id antes do nome: o nome gravado é o da época e o CV renomeia.
        const escopo = await resolverEscopo({ idempreendimento_cv: r.idempreendimento_cv, nome: r.empreendimento });
        const e = episodioDeReserva({
            id: r.idreserva,
            criada_em: r.data_reserva,
            entrou_na_etapa_em: r.data_reserva,
            etapa_anterior: r.etapa || 'reserva',
            etapa: r.data_contrato ? 'contrato' : (r.status_reserva || null),
            mudou_em: fim,
            data_contrato: r.data_contrato,
            status_final: r.status_reserva,
            escopo,
        }, { cfg, agora });
        if (e) out.push(e);
    }
    return out;
}

/** Repasses: quanto tempo preso, em que pendência, e o SLA do próprio caso. */
async function coletarRepasses({ janela, cfg, agora }) {
    const desde = new Date(agora.getTime() - janela * DIA);
    const rows = await db.Repasse.findAll({
        where: { data_status_repasse: { [Op.gte]: desde } },
        attributes: [
            'idrepasse', 'empreendimento', 'idempreendimento_cv', 'etapa', 'status_repasse',
            'data_status_repasse', 'data_contrato_liberado', 'sla_prazo_repasse',
            'data_assinatura', 'proxima_acao',
        ],
        limit: LIMITE,
        raw: true,
    });

    const out = [];
    for (const r of rows) {
        const travou = r.data_contrato_liberado;
        const destravou = r.data_assinatura || r.data_status_repasse;
        if (!travou || !destravou) continue;

        // Id antes do nome: o nome gravado é o da época e o CV renomeia.
        const escopo = await resolverEscopo({ idempreendimento_cv: r.idempreendimento_cv, nome: r.empreendimento });
        const e = episodioDeRepasse({
            id: r.idrepasse,
            travou_em: travou,
            destravado_em: destravou,
            pendencia: r.etapa || null,
            sla_dias: r.sla_prazo_repasse,
            destravou_por: r.proxima_acao || null,
            escopo,
        }, { cfg, agora });
        if (e) out.push(e);
    }
    return out;
}

/**
 * Performance: desvio da semana contra a média do PRÓPRIO corretor.
 *
 * A média própria é a chave. Comparar todo mundo com o melhor acende alerta
 * toda semana para metade do time, e alerta que sempre acende ninguém lê.
 */
async function coletarPerformance({ janela, cfg, agora }) {
    const desde = new Date(agora.getTime() - janela * DIA);
    const rows = await db.Lead.findAll({
        where: { data_cad: { [Op.gte]: desde } },
        attributes: ['idlead', 'data_cad', 'corretor', 'empreendimento', 'qtde_reservas_associadas'],
        limit: LIMITE * 3,
        raw: true,
    });

    // corretor → semana → { leads, conversoes, escopoFonte }
    const porCorretor = new Map();
    for (const r of rows) {
        const id = r.corretor?.idcorretor ?? r.corretor?.id ?? null;
        if (id == null) continue;

        const d = new Date(r.data_cad);
        if (Number.isNaN(d.getTime())) continue;
        // Domingo da semana do lead: agrupa sem depender de locale.
        const dom = new Date(d);
        dom.setUTCDate(dom.getUTCDate() - dom.getUTCDay());
        const semana = dom.toISOString().slice(0, 10);

        if (!porCorretor.has(id)) porCorretor.set(id, new Map());
        const sem = porCorretor.get(id);
        if (!sem.has(semana)) sem.set(semana, { leads: 0, conv: 0, fonte: r.empreendimento });
        const s = sem.get(semana);
        s.leads++;
        if (Number(r.qtde_reservas_associadas) > 0) s.conv++;
    }

    const out = [];
    for (const [corretorId, semanas] of porCorretor) {
        const lista = [...semanas.entries()]
            .map(([semana, s]) => ({ semana, ...s, taxa: s.leads ? s.conv / s.leads : 0 }))
            .filter(s => s.leads >= 3)          // semana curta não vira episódio
            .sort((a, b) => a.semana.localeCompare(b.semana));

        // Precisa de histórico para ter média própria. Menos de 4 semanas é
        // opinião sobre alguém com base em nada.
        if (lista.length < 4) continue;

        for (let i = 3; i < lista.length; i++) {
            const anteriores = lista.slice(Math.max(0, i - 8), i);
            const media = anteriores.reduce((s, x) => s + x.taxa, 0) / anteriores.length;
            const atual = lista[i];

            const escopo = await resolverEscopo(atual.fonte);
            const fim = new Date(new Date(atual.semana).getTime() + 6 * DIA);

            const e = episodioDePerformance({
                corretor_id: corretorId,
                fim,
                media_propria: media,
                conversao: atual.taxa,
                leads: atual.leads,
                escopo,
            }, { cfg, agora });
            if (e) out.push(e);
        }
    }
    return out;
}

/** `gatilho.fonte` do processo → coletor. Fonte desconhecida não roda nada. */
const COLETORES = {
    cv_leads: coletarLeads,
    cv_reservas: coletarReservas,
    cv_repasse: coletarRepasses,
    cv_performance: coletarPerformance,
};

export const FONTES = Object.keys(COLETORES);

/**
 * Roda o coletor de um processo.
 *
 * Nunca lança: o motor é acessório e uma falha aqui não pode virar log de erro
 * que assusta quem está olhando o boot. Devolve lista vazia e o motivo.
 *
 * @returns {Promise<{observacoes:Array, erro:string|null}>}
 */
export async function coletar(processo, { cfg = {}, agora = new Date() } = {}) {
    const fonte = processo?.gatilho?.fonte;
    const fn = COLETORES[fonte];
    if (!fn) return { observacoes: [], erro: `Fonte "${fonte || 'não definida'}" não tem coletor.` };

    const janela = Number(cfg.janela_dias) > 0 ? Number(cfg.janela_dias) : PADROES.janela_dias;

    try {
        const observacoes = await fn({ janela, cfg, agora });
        return {
            observacoes: observacoes.map(o => ({ ...o, processo_key: processo.key })),
            erro: null,
        };
    } catch (err) {
        console.warn(`[processos/coletor] ${processo.key}:`, err?.message);
        return { observacoes: [], erro: String(err?.message || err).slice(0, 300) };
    }
}

export default { coletar, FONTES };

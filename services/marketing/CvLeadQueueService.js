// services/marketing/CvLeadQueueService.js
//
// As filas de distribuição de leads do CV e o mapa "empreendimento -> fila".
//
// Existe porque o CV decide a fila por regras que ele não expõe e que não cobrem
// lead com interesse em várias praças: em 26/08/2026 o protocolo do lead 12361
// registrou "Lead não encontrou uma fila compatível e foi represado". Sem fila
// explícita o lead fica sem dono e ninguém é avisado.
//
// O VÍNCULO É POR ID E É DECLARADO POR GENTE. Não se deduz fila por nome:
// "Fila Park Alameda" casa com "BOULEVARD PARK & RESORT" e manda o lead para a
// praça errada. Nome muda, id não — e é o id que o CV usa. Por isso aqui não
// existe casamento automático: o que é automático é a LISTA de filas, que o CV
// atualiza sempre, e a detecção de vínculo quebrado (fila que sumiu do CV).
// Renomear a fila no CV não quebra nada, porque o vínculo é pelo id.
//
// O QUE A API NÃO CONTA (medido em 26/08/2026): ela devolve só
// `idfila_distribuicao_leads`, `nome`, `corretores_e_imobiliarias` e `gestores`.
// Não devolve se a fila está ativa, nem os GRUPOS de atendimento. Fila com lista
// de corretores vazia pode estar cheia por grupo — o painel do CV mostra
// "Grupos: 2" onde a API mostra nada. Então `sem_atendente_listado` é INFORMATIVO
// e nunca bloqueia: bloquear por ele esconderia filas boas.
//
// A conferência de verdade é depois do fato: quem devolve um lead relê o lead ao
// vivo e vê se a fila entregou (CvLeadReturnService.readLiveLead).

import { Op } from 'sequelize';
import apiCv from '../../lib/apiCv.js';
import db from '../../models/sequelize/index.js';

const { CvLeadQueue, CvLeadQueueBinding, OrgEnterprise } = db;

export const ORIGEM = { MANUAL: 'manual' };

// ── Sync das filas ──────────────────────────────────────────────────────────

/**
 * Traz as filas do CV para o espelho local.
 * @returns {Promise<{total:number, novas:number, sumiram:number, semAtendenteListado:number}>}
 */
export async function syncQueues() {
    const r = await apiCv.get('/v1/comercial/filas-distribuicao-leads', { params: { limite: 50 } });
    const filas = r.data?.filas || [];
    if (!filas.length) throw new Error('CV devolveu nenhuma fila de distribuição.');

    const agora = new Date();
    const vistos = [];
    let novas = 0;

    for (const f of filas) {
        const idfila = Number(f.idfila_distribuicao_leads);
        if (!Number.isInteger(idfila)) continue;
        vistos.push(idfila);

        const corretores = f.corretores_e_imobiliarias || [];
        const gestores = f.gestores || [];
        const [, criado] = await CvLeadQueue.upsert({
            idfila,
            nome: f.nome || `Fila ${idfila}`,
            corretores,
            gestores,
            qtd_corretores: corretores.length,
            qtd_gestores: gestores.length,
            sem_atendente_listado: !corretores.length && !gestores.length,
            presente_no_cv: true,
            synced_at: agora,
        });
        if (criado) novas += 1;
    }

    // Fila que sumiu do CV fica marcada, não apagada: pode ter vínculo nela.
    const [, sumiram] = await CvLeadQueue.update(
        { presente_no_cv: false },
        { where: { idfila: { [Op.notIn]: vistos } } },
    );

    const semAtendenteListado = await CvLeadQueue.count({ where: { sem_atendente_listado: true, presente_no_cv: true } });
    console.log(`[cv-filas] sync: ${vistos.length} filas (${novas} novas, ${semAtendenteListado} sem atendente listado).`);
    return { total: vistos.length, novas, sumiram: sumiram || 0, semAtendenteListado };
}

/** O que o scheduler e o botão "Sincronizar" da tela chamam. */
export async function refresh() {
    return { sync: await syncQueues() };
}

// ── Consulta ────────────────────────────────────────────────────────────────

/**
 * A fila que atende um empreendimento, ou null.
 * Recusa só fila que sumiu do CV — vínculo apontando para o vazio manda o lead
 * para lugar nenhum. NÃO recusa por "sem atendente listado": a API não enxerga
 * grupo de atendimento, então essa lista vazia não prova fila vazia.
 *
 * @returns {Promise<{idfila:number,nome:string,origem:string,motivo:?string}|null>}
 */
export async function resolveFila(idempreendimento) {
    const id = Number(idempreendimento);
    if (!Number.isInteger(id)) return null;

    const binding = await CvLeadQueueBinding.findByPk(id);
    if (!binding?.idfila) return null;

    const fila = await CvLeadQueue.findByPk(binding.idfila);
    if (!fila || !fila.presente_no_cv) return null;

    return { idfila: fila.idfila, nome: fila.nome, origem: binding.origem, motivo: binding.motivo };
}

/**
 * O próximo corretor do rodízio de uma fila — e avança a posição.
 *
 * Existe porque o CV NÃO distribui lead devolvido por API (medido 28/08/2026,
 * leads 35091/34987: fila explícita + lead_utilizar_fila + forcar_distribuicao
 * movem o lead para "Aguardando Atendimento Corretor" e ninguém é associado).
 * O que a API aplica de verdade é a associação direta idcorretor/idimobiliaria
 * no POST de lead — então o rodízio quem faz é o Office, sobre a lista de
 * membros que a própria API da fila devolve.
 *
 * @returns {Promise<{idcorretor:number, idimobiliaria:?number, nome:?string, imobiliaria:?string}|null>}
 */
export async function proximoDoRodizio(idfila) {
    const fila = await CvLeadQueue.findByPk(Number(idfila));
    if (!fila) return null;

    const membros = (Array.isArray(fila.corretores) ? fila.corretores : [])
        .filter(m => Number.isInteger(Number(m?.idcorretor)));
    if (!membros.length) return null;

    const pos = ((fila.rodizio_pos ?? -1) + 1) % membros.length;
    await fila.update({ rodizio_pos: pos });

    const m = membros[pos];
    return {
        idcorretor: Number(m.idcorretor),
        idimobiliaria: m.idimobiliaria != null ? Number(m.idimobiliaria) : null,
        nome: m.nome_corretor || null,
        imobiliaria: m.nome_imobiliaria || null,
    };
}

/** Filas + a quem cada uma atende. É o que a tela desenha. */
export async function listWithBindings() {
    const [filas, bindings, empreendimentos] = await Promise.all([
        CvLeadQueue.findAll({ order: [['nome', 'ASC']] }),
        CvLeadQueueBinding.findAll(),
        OrgEnterprise.findAll({
            where: { cv_id: { [Op.ne]: null }, active: true },
            attributes: ['cv_id', 'name', 'city'],
            order: [['name', 'ASC']],
        }),
    ]);

    const porEmp = new Map(bindings.map(b => [b.idempreendimento, b]));
    const nomeEmp = new Map(empreendimentos.map(e => [e.cv_id, e]));

    return {
        filas: filas.map(f => ({
            idfila: f.idfila,
            nome: f.nome,
            corretores: f.corretores || [],
            qtd_corretores: f.qtd_corretores,
            sem_atendente_listado: f.sem_atendente_listado,
            presente_no_cv: f.presente_no_cv,
            synced_at: f.synced_at,
            empreendimentos: bindings
                .filter(b => b.idfila === f.idfila)
                .map(b => ({
                    idempreendimento: b.idempreendimento,
                    nome: nomeEmp.get(b.idempreendimento)?.name || `empreendimento ${b.idempreendimento}`,
                    origem: b.origem,
                    motivo: b.motivo,
                })),
        })),
        // TODOS os empreendimentos com a fila atual. É a lista de edição: sem
        // ela, só daria para vincular o que ainda não tem fila, e trocar um
        // vínculo já feito viraria um beco.
        empreendimentos: empreendimentos.map(e => {
            const b = porEmp.get(e.cv_id);
            const fila = b?.idfila ? filas.find(f => f.idfila === b.idfila) : null;
            return {
                idempreendimento: e.cv_id,
                nome: e.name,
                cidade: e.city,
                idfila: b?.idfila || null,
                fila_nome: fila?.nome || null,
                fila_sumiu_do_cv: !!(b?.idfila && !fila?.presente_no_cv),
                motivo: b?.motivo || null,
            };
        }),
        // Recorte de quem está sem fila: é o que trava o retorno automático de
        // lead, então a tela cobra isso em destaque em vez de escondê-lo no meio.
        sem_fila: empreendimentos
            .filter(e => !porEmp.get(e.cv_id)?.idfila)
            .map(e => ({ idempreendimento: e.cv_id, nome: e.name, cidade: e.city })),
    };
}

/** Escolha manual da tela. Vence o automático e não é recalculada. */
export async function setBinding({ idempreendimento, idfila, userId = null }) {
    const id = Number(idempreendimento);
    if (!Number.isInteger(id)) throw new Error('idempreendimento inválido.');

    if (idfila == null) {
        await CvLeadQueueBinding.destroy({ where: { idempreendimento: id } });
        return { idempreendimento: id, idfila: null };
    }

    const fila = await CvLeadQueue.findByPk(Number(idfila));
    if (!fila) throw new Error(`Fila ${idfila} não existe no espelho — rode o sync.`);

    await CvLeadQueueBinding.upsert({
        idempreendimento: id,
        idfila: fila.idfila,
        origem: ORIGEM.MANUAL,
        motivo: `${fila.nome} — escolha manual`,
        definido_por: userId,
    });
    return { idempreendimento: id, idfila: fila.idfila, nome: fila.nome };
}

export default { syncQueues, refresh, resolveFila, proximoDoRodizio, listWithBindings, setBinding, ORIGEM };

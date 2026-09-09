// services/boleto/AtoParcelaService.js
//
// O PLANO de parcelas de cada reserva: nasce, sincroniza com o CV, pausa,
// encerra (sozinho ou pela tela) e alimenta a aba Parcelas.
//
// Regras puras em lib/atoParcelas.js. Emissao de boleto em
// ParcelaEmissaoService.js. Aqui e o estado do plano.
//
// Fontes:
//   - condicoes do CV: tabela local `reservas` (sync horario) para a adesao em
//     massa; API do CV ao vivo quando vai emitir (ParcelaEmissaoService).
//   - "Sienge faturou": tabela local `contracts` (sync horario, external_id =
//     idreserva) pelo `financial_institution_date` (venda faturada, a regra do
//     relatorio de Faturamento). O titulo (`receivable_bill_id`) NAO conta.
//   - "a Caixa emitiu o contrato": etapa do repasse na tabela local `repasses`.
//   - reserva morta: `reservas.situacao.idsituacao` em `cv_situacoes_reserva_morta`.
import db from '../../models/sequelize/index.js';
import apiCv from '../../lib/apiCv.js';
import { Op } from 'sequelize';
import { allowedEnterpriseNames } from './boletoScope.js';
import {
    PARCELAS_DEFAULTS, PLANO_STATUS, PARCELA_STATUS,
    derivarParcelas, chaveParcela, diffPlano, motivoEncerramento, MOTIVOS_TRANSFERENCIA, hojeYmd, diffDays, addDays, empreendimentoExcluido,
} from '../../lib/atoParcelas.js';

const { AtoPlano, AtoParcela, BoletoHistory, BoletoSettings, UseredeLinkHistory } = db;

// ── Configuração ──────────────────────────────────────────────────────────────

/** Settings do modulo com os defaults das parcelas preenchidos. */
export async function getSettings() {
    let s = await BoletoSettings.findByPk(1);
    if (!s) s = await BoletoSettings.create({ id: 1 });
    return s;
}

/** Recorte normalizado da configuracao das parcelas (numeros ja tratados). */
export function cfgParcelas(s) {
    const D = PARCELAS_DEFAULTS;
    const num = (v, d) => (v == null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
    const ids = Array.isArray(s?.parcelas_idseries) && s.parcelas_idseries.length ? s.parcelas_idseries : D.idseries;
    return {
        ativo: !!s?.parcelas_ativo,
        moduloAtivo: !!s?.active,
        idseries: ids,
        empreendimentosExcluidos: Array.isArray(s?.parcelas_empreendimentos_excluidos) ? s.parcelas_empreendimentos_excluidos : D.empreendimentosExcluidos,
        exigirAtoPago: s?.parcelas_exigir_ato_pago ?? D.exigirAtoPago,
        antecedenciaDias: num(s?.parcelas_antecedencia_dias, D.antecedenciaDias),
        encerrarQuandoFaturado: s?.parcelas_encerrar_quando_faturado ?? D.encerrarQuandoFaturado,
        // CEP recusado pela Caixa -> endereco de contingencia (o da Menin) e alerta na reserva.
        cepContingenciaAtivo: s?.parcelas_cep_contingencia_ativo ?? D.cepContingenciaAtivo,
        cepContingencia: { ...D.cepContingencia, ...((s?.parcelas_cep_contingencia && typeof s.parcelas_cep_contingencia === 'object') ? s.parcelas_cep_contingencia : {}) },
        // Etapas do repasse do CV que encerram o plano ([] = regra desligada; null/ausente = padrao).
        encerrarEtapasRepasse: Array.isArray(s?.parcelas_encerrar_etapas_repasse)
            ? s.parcelas_encerrar_etapas_repasse.map(Number).filter(n => Number.isInteger(n) && n > 0)
            : D.encerrarEtapasRepasse,
        vencidasNaAdesao: s?.parcelas_vencidas_na_adesao || D.vencidasNaAdesao,
        // 'YYYY-MM-DD' ou null. Parcela com vencimento original antes disto e
        // RETROATIVA: a rodada nao toca (trabalho manual pela tela).
        cobrarAPartirDe: s?.parcelas_cobrar_a_partir_de ? String(s.parcelas_cobrar_a_partir_de).slice(0, 10) : null,
        horaRodada: num(s?.parcelas_hora_rodada, D.horaRodada),
        maxEmissoesRodada: num(s?.parcelas_max_emissoes_rodada, D.maxEmissoesRodada), // 0 = sem teto
        loteTamanho: num(s?.parcelas_lote_tamanho, D.loteTamanho),
        lotePausaMin: num(s?.parcelas_lote_pausa_min, D.lotePausaMin),
        atrasoReemitir: s?.atraso_reemitir ?? D.atrasoReemitir, // false = a pedido (cliente/tela)
        atrasoMaxReemissoes: num(s?.atraso_max_reemissoes, D.atrasoMaxReemissoes),
        // Multa e juros ficaram FORA desta etapa (decisao de 07/09/2026): a
        // reemissao por atraso sai com o valor original e vencimento novo. O
        // calculo existe em lib/atoParcelas.js para quando for a hora.
        atrasoCobrarEncargos: false,
        atrasoMultaPct: 0,
        atrasoJurosMesPct: 0,
        lembreteDiasAntes: num(s?.lembrete_dias_antes, D.lembreteDiasAntes),
        avisoAtrasoDiasDepois: num(s?.aviso_atraso_dias_depois, D.avisoAtrasoDiasDepois),
        // Aviso FINAL (sem nova via): sai quando as vias acabaram ou quando o
        // ultimo aviso de atraso ficou N dias sem resposta (0 desliga a 2a condicao).
        avisoFinalSemRespostaDias: num(s?.aviso_final_sem_resposta_dias, D.avisoFinalSemRespostaDias),
        situacoesMortas: Array.isArray(s?.cv_situacoes_reserva_morta) ? s.cv_situacoes_reserva_morta : [4],
        valorMaximo: s?.valor_maximo != null ? Number(s.valor_maximo) : null,
    };
}

// ── Leituras auxiliares ───────────────────────────────────────────────────────

/** Reserva ao vivo no CV (titular, unidade, condicoes, cancelamento). */
export async function carregarReservaCv(idreserva) {
    const resp = await apiCv.get(`/v1/comercial/reservas/${idreserva}`);
    const data = resp.data?.[idreserva];
    if (!data) throw new Error(`Reserva ${idreserva} nao encontrada no CV.`);
    return data;
}

/**
 * Reserva "vista" pelo plano: do CV (normal) ou de `teste_dados` quando o plano
 * e de TESTE (reserva ficticia, so no Office). Devolve o mesmo formato que a
 * API do CV: { titular, unidade, condicoes, data_cancelamento }.
 */
export async function carregarReservaDoPlano(plano) {
    if (plano?.origem === 'teste') {
        const t = plano.teste_dados || {};
        return { titular: t.titular || {}, unidade: t.unidade || {}, condicoes: { series: t.series || [] }, data_cancelamento: null, data_distrato: null };
    }
    return carregarReservaCv(plano.idreserva);
}

/**
 * Plano de TESTE: reserva ficticia (id que nao existe no CV) com titular,
 * unidade, CNPJ e series informados. Nasce com o ato "pago". Serve para
 * exercitar o fluxo real de boleto/e-mail/WhatsApp sem criar reserva no CV.
 * Apagar com ParcelaEmissaoService.limparTeste(idreserva).
 */
export async function criarPlanoTeste({ idreserva, titular, unidade, cnpj, series, userId = null, idseries }) {
    const existente = await AtoPlano.findOne({ where: { idreserva } });
    if (existente) throw new Error(`Ja existe plano para a reserva ${idreserva}.`);
    const derivadas = derivarParcelas(series, { idseries: idseries || PARCELAS_DEFAULTS.idseries });
    if (!derivadas.length) throw new Error('Series sem parcela mensal.');
    const plano = await AtoPlano.create({
        idreserva, idpessoa_cv: titular.idpessoa_cv || null, titular_nome: titular.nome, empreendimento: unidade.empreendimento,
        idempreendimento_cv: unidade.idempreendimento_cv || null, unidade: unidade.unidade || null, cnpj_empresa: cnpj,
        status: PLANO_STATUS.ATIVO, origem: 'teste', ato_pago_em: new Date(), cv_sincronizado_em: new Date(),
        teste_dados: { titular, unidade, series }, observacao: 'PLANO DE TESTE - reserva nao existe no CV', updated_by: userId,
    });
    await AtoParcela.bulkCreate(derivadas.map(d => ({
        plano_id: plano.id, idreserva, chave: chaveParcela(d), idserie: d.idserie, linha: d.linha, indice_na_serie: d.indice_na_serie,
        serie_nome: d.serie_nome, sigla: d.sigla, numero: d.numero, total: d.total, vencimento: d.vencimento, valor: d.valor, status: PARCELA_STATUS.PREVISTA,
    })));
    return plano;
}

/** Reserva da tabela local (sync horario) - barata, serve para adesao em massa. */
/**
 * Ultimo repasse da reserva na tabela local `repasses` (sincronizada do CV).
 * 112 reservas tem mais de um repasse (reentrada): vale o mais novo. A etapa
 * do workflow e `idsituacao_repasse`/`status_repasse` - `etapa` e a FASE do
 * empreendimento (MODULO 02), nao confundir.
 */
export async function repasseAtual(idreserva) {
    const [row] = await db.sequelize.query(
        `SELECT idrepasse, idsituacao_repasse, status_repasse, data_status_repasse
           FROM repasses WHERE idreserva = :id
          ORDER BY idrepasse DESC LIMIT 1`,
        { replacements: { id: Number(idreserva) }, type: db.Sequelize.QueryTypes.SELECT },
    );
    return row || null;
}

/**
 * Catalogo das etapas do repasse para a tela escolher quais encerram o plano:
 * o workflow do CV (ordem oficial) e, se a API falhar, o que existe na base.
 */
export async function listarEtapasRepasse() {
    try {
        const { data } = await apiCv.get('/v1/cv/workflow/repasses');
        const lista = (Array.isArray(data) ? data : []).map(x => ({ id: Number(x.idsituacao), nome: x.nome, ordem: Number(x.ordem) || 0 }))
            .filter(x => x.id > 0).sort((a, b) => a.ordem - b.ordem);
        if (lista.length) return { etapas: lista, fonte: 'cv' };
    } catch (err) {
        console.warn('[PARCELAS] workflow de repasses no CV falhou, usando a base local:', err.message);
    }
    const [rows] = await db.sequelize.query(`SELECT idsituacao_repasse id, max(status_repasse) nome FROM repasses WHERE idsituacao_repasse IS NOT NULL GROUP BY 1 ORDER BY 1`);
    return { etapas: rows.map(r => ({ id: Number(r.id), nome: r.nome, ordem: Number(r.id) })), fonte: 'local' };
}

async function carregarReservaLocal(idreserva) {
    const [row] = await db.sequelize.query(
        `SELECT idreserva, titular, unidade_json, condicoes, situacao, empreendimento, unidade
           FROM reservas WHERE idreserva = :id`,
        { replacements: { id: idreserva }, type: db.Sequelize.QueryTypes.SELECT },
    );
    return row || null;
}

/** O ato desta reserva foi pago? (boleto do ato OU link de cartao) */
export async function atoPago(idreserva) {
    const [b, c] = await Promise.all([
        BoletoHistory.findOne({
            where: { idreserva, status: 'success', payment_status: 'paid', ignorado: false, parcela_id: null },
            order: [['id', 'DESC']], attributes: ['id', 'paid_at'],
        }),
        UseredeLinkHistory.findOne({
            where: { idreserva, status: 'success', payment_status: 'paid', ignorado: false },
            order: [['id', 'DESC']], attributes: ['id', 'paid_at'],
        }).catch(() => null),
    ]);
    if (!b && !c) return null;
    return { forma: b ? 'boleto' : 'cartao', paid_at: (b || c).paid_at, id: (b || c).id };
}

/** Contrato local do Sienge da reserva (o nao-cancelado mais recente). */
export async function contratoSienge(idreserva) {
    const [row] = await db.sequelize.query(
        `SELECT id, situation, financial_institution_date, contract_date, issue_date
           FROM contracts
          WHERE external_id = :ext
          ORDER BY (lower(coalesce(situation,'')) = 'cancelado') ASC, id DESC
          LIMIT 1`,
        { replacements: { ext: String(idreserva) }, type: db.Sequelize.QueryTypes.SELECT },
    );
    return row || null;
}

function reservaCanceladaCv(reservaCv) {
    return !!(reservaCv?.data_cancelamento || reservaCv?.data_distrato);
}

function situacaoMortaLocal(reservaLocal, situacoesMortas) {
    const id = Number(reservaLocal?.situacao?.idsituacao);
    return Number.isFinite(id) && situacoesMortas.map(Number).includes(id);
}

// ── Criação / sincronização ───────────────────────────────────────────────────

function denormDaReserva(r, viaCv) {
    if (viaCv) {
        const { titular, unidade } = r;
        return {
            idpessoa_cv: titular?.idpessoa_cv || null,
            titular_nome: titular?.nome || null,
            empreendimento: unidade?.empreendimento || null,
            idempreendimento_cv: unidade?.idempreendimento_cv || null,
            unidade: unidade?.unidade || unidade?.nome || null,
        };
    }
    const t = r.titular || {};
    const u = r.unidade_json || {};
    return {
        idpessoa_cv: t.idpessoa_cv || null,
        titular_nome: t.nome || null,
        empreendimento: u.empreendimento || r.empreendimento || null,
        idempreendimento_cv: u.idempreendimento_cv || null,
        unidade: u.unidade || r.unidade || null,
    };
}

/**
 * Cria o plano da reserva (ou sincroniza o existente) a partir das condicoes.
 *
 * @param {number} idreserva
 * @param {object} [opts]
 * @param {object} [opts.reservaCv]     reserva ja carregada da API do CV
 * @param {boolean} [opts.preferirLocal] usa a tabela `reservas` (adesao em massa)
 * @param {'ato_pago'|'manual'} [opts.origem]
 * @param {number} [opts.userId]
 * @param {object} [opts.settings]
 * @returns {Promise<{ plano: object|null, criado: boolean, resumo: object, skipped?: string }>}
 */
export async function criarOuSincronizarPlano(idreserva, opts = {}) {
    const settings = opts.settings || await getSettings();
    const cfg = cfgParcelas(settings);
    idreserva = Number(idreserva);

    let reserva = opts.reservaCv || null;
    let viaCv = !!reserva;
    if (!reserva && opts.preferirLocal) {
        reserva = await carregarReservaLocal(idreserva);
        viaCv = false;
    }
    if (!reserva) {
        reserva = await carregarReservaCv(idreserva);
        viaCv = true;
    }

    const cancelada = viaCv ? reservaCanceladaCv(reserva) : situacaoMortaLocal(reserva, cfg.situacoesMortas);
    const series = reserva?.condicoes?.series || [];
    const derivadas = derivarParcelas(series, { idseries: cfg.idseries });

    let plano = await AtoPlano.findOne({ where: { idreserva } });

    if (!plano) {
        if (cancelada) return { plano: null, criado: false, skipped: 'reserva_cancelada', resumo: {} };
        if (!derivadas.length) return { plano: null, criado: false, skipped: 'sem_series', resumo: {} };
        // Empreendimento fora da cobranca (Configuracoes): a reserva nao entra.
        if (empreendimentoExcluido(denormDaReserva(reserva, viaCv).empreendimento, cfg.empreendimentosExcluidos) && opts.origem !== 'manual') {
            return { plano: null, criado: false, skipped: 'empreendimento_excluido', resumo: {} };
        }
        if (cfg.exigirAtoPago && opts.origem !== 'manual') {
            const pago = await atoPago(idreserva);
            if (!pago) return { plano: null, criado: false, skipped: 'ato_nao_pago', resumo: {} };
            opts.atoPagoEm = pago.paid_at;
        }
        const [contrato, repasse] = await Promise.all([contratoSienge(idreserva), repasseAtual(idreserva)]);
        plano = await AtoPlano.create({
            idreserva,
            ...denormDaReserva(reserva, viaCv),
            status: PLANO_STATUS.ATIVO,
            origem: opts.origem || 'ato_pago',
            ato_pago_em: opts.atoPagoEm || null,
            sienge_contract_id: contrato?.id || null,
            sienge_venda_faturada_em: contrato?.financial_institution_date || null,
            sienge_verificado_em: new Date(),
            cv_repasse_id: repasse?.idrepasse || null,
            cv_repasse_situacao_id: repasse?.idsituacao_repasse || null,
            cv_repasse_situacao: repasse?.status_repasse || null,
            cv_sincronizado_em: new Date(),
            updated_by: opts.userId || null,
        });
        await AtoParcela.bulkCreate(derivadas.map(d => ({
            plano_id: plano.id, idreserva, chave: chaveParcela(d),
            idserie: d.idserie, linha: d.linha, indice_na_serie: d.indice_na_serie,
            serie_nome: d.serie_nome, sigla: d.sigla,
            numero: d.numero, total: d.total, vencimento: d.vencimento, valor: d.valor,
            status: PARCELA_STATUS.PREVISTA,
        })));
        // Ja nasceu faturado, cancelado ou com o repasse alem de "Contrato Emitido CAIXA"? Encerra na hora, sem emitir nada.
        const motivo = motivoEncerramento({
            contrato, reservaCancelada: cancelada, encerrarQuandoFaturado: cfg.encerrarQuandoFaturado,
            repasseSituacaoId: repasse?.idsituacao_repasse || null, encerrarEtapasRepasse: cfg.encerrarEtapasRepasse,
        });
        if (motivo) await encerrarPlano(plano, motivo, { detalhe: 'detectado na criacao do plano' });
        console.log(`[PARCELAS] Plano criado para a reserva ${idreserva}: ${derivadas.length} parcela(s)${motivo ? ` - encerrado (${motivo})` : ''}.`);
        return { plano, criado: true, resumo: { parcelas: derivadas.length, encerrado: motivo || null } };
    }

    // ── Plano existente: CONGELADO (decisao de 07/09/2026) ───────────────────
    // Depois do Envio Sienge a condicao da reserva no CV nao muda mais o plano.
    // Por padrao esta funcao so REGISTRA o que diverge (a tela mostra); nada e
    // alterado. Mudanca no plano e so por admin, dentro do Office: editar a
    // parcela (editarParcela) ou aplicar as condicoes do CV de proposito
    // (`aplicarCv: true`, botao da tela).
    const gravadas = await AtoParcela.findAll({ where: { plano_id: plano.id }, raw: true });
    const d = diffPlano(gravadas, derivadas);

    if (!opts.aplicarCv) {
        const divergencias = [
            ...d.atualizar.map(x => ({ tipo: 'prevista_mudou', parcelaId: x.id, numero: x.numero, cv: { valor: x.valor, vencimento: x.vencimento } })),
            ...d.divergentes.map(x => ({ tipo: 'condicao_mudou', parcelaId: x.id, atual: x.atual, cv: x.cv })),
            ...d.novas.map(x => ({ tipo: 'serie_nova', numero: x.numero, cv: { valor: x.valor, vencimento: x.vencimento } })),
            ...d.remover.map(x => ({ tipo: 'serie_sumiu', parcelaId: x.id, numero: x.numero })),
            ...d.orfas.map(x => ({ tipo: 'serie_sumiu', parcelaId: x.id, numero: x.numero })),
        ];
        await plano.update({
            ...denormDaReserva(reserva, viaCv),
            cv_sincronizado_em: new Date(),
            divergencias: divergencias.length ? divergencias : null,
        });
        return { plano, criado: false, aplicado: false, resumo: { divergencias: divergencias.length } };
    }

    if (d.novas.length) {
        await AtoParcela.bulkCreate(d.novas.map(n => ({
            plano_id: plano.id, idreserva, chave: chaveParcela(n),
            idserie: n.idserie, linha: n.linha, indice_na_serie: n.indice_na_serie,
            serie_nome: n.serie_nome, sigla: n.sigla,
            numero: n.numero, total: n.total, vencimento: n.vencimento, valor: n.valor,
            status: PARCELA_STATUS.PREVISTA,
        })));
    }
    for (const a of d.atualizar) {
        await AtoParcela.update(
            { numero: a.numero, total: a.total, vencimento: a.vencimento, valor: a.valor },
            { where: { id: a.id, status: PARCELA_STATUS.PREVISTA } },
        );
    }
    if (d.remover.length) {
        await AtoParcela.destroy({ where: { id: d.remover.map(r => r.id), status: PARCELA_STATUS.PREVISTA } });
    }
    // Renumera tudo (numero/total) para parcelas que ja existiam com a mesma
    // condicao mas mudaram de posicao. So `numero`/`total`: valor/vencimento das
    // emitidas nunca sao tocados.
    const porChave = new Map(derivadas.map(x => [chaveParcela(x), x]));
    const todas = await AtoParcela.findAll({ where: { plano_id: plano.id }, attributes: ['id', 'chave', 'numero', 'total'], raw: true });
    for (const t of todas) {
        const x = porChave.get(t.chave);
        if (x && (x.numero !== t.numero || x.total !== t.total)) {
            await AtoParcela.update({ numero: x.numero, total: x.total }, { where: { id: t.id } });
        }
    }

    const divergencias = [
        ...d.divergentes.map(x => ({ tipo: 'condicao_mudou', parcelaId: x.id, atual: x.atual, cv: x.cv })),
        ...d.orfas.map(x => ({ tipo: 'serie_sumiu', parcelaId: x.id, numero: x.numero })),
    ];
    await plano.update({
        ...denormDaReserva(reserva, viaCv),
        cv_sincronizado_em: new Date(),
        divergencias: divergencias.length ? divergencias : null,
        updated_by: opts.userId ?? plano.updated_by,
    });

    return {
        plano, criado: false, aplicado: true,
        resumo: { novas: d.novas.length, atualizadas: d.atualizar.length, removidas: d.remover.length, divergencias: divergencias.length },
    };
}

/**
 * Edicao manual de uma parcela (admin, dentro do Office): valor e/ou
 * vencimento ORIGINAIS. So parcela sem boleto vivo (prevista, vencida, erro).
 * E o unico caminho, alem de "aplicar CV", que muda um plano congelado.
 */
export async function editarParcela(parcela, { valor, vencimento, userId = null, motivo = null }) {
    if (![PARCELA_STATUS.PREVISTA, PARCELA_STATUS.VENCIDA, PARCELA_STATUS.ERRO].includes(parcela.status)) {
        throw new Error(`Parcela ${parcela.status} nao pode ser editada (baixe ou aguarde o boleto).`);
    }
    const upd = { updated_by: userId };
    if (valor !== undefined && valor !== null && valor !== '') {
        const v = Number(valor);
        if (!Number.isFinite(v) || v <= 0) throw new Error('Valor deve ser um numero maior que zero.');
        upd.valor = Number(v.toFixed(2));
    }
    if (vencimento) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(vencimento))) throw new Error('Vencimento deve ser uma data (AAAA-MM-DD).');
        upd.vencimento = String(vencimento);
    }
    const antes = { valor: parcela.valor, vencimento: parcela.vencimento };
    await parcela.update(upd);
    console.log(`[PARCELAS] parcela ${parcela.id} editada por ${userId}: ${JSON.stringify(antes)} -> ${JSON.stringify({ valor: parcela.valor, vencimento: parcela.vencimento })}${motivo ? ` (${motivo})` : ''}`);
    return parcela;
}

// ── Encerramento / pausa ──────────────────────────────────────────────────────

/**
 * Encerra o plano. Parcelas previstas/erro viram `transferida` (Sienge) ou
 * `cancelada` (reserva morta / manual). Parcelas com boleto VIVO ficam como
 * estao - quem baixa e o ParcelaEmissaoService (precisa do Playwright), que a
 * rodada chama logo depois. Devolve os ids dessas parcelas para isso.
 */
export async function encerrarPlano(plano, motivo, { detalhe = null, userId = null } = {}) {
    const statusPlano = motivo === 'reserva_cancelada' ? PLANO_STATUS.CANCELADO : PLANO_STATUS.ENCERRADO;
    const statusParcela = MOTIVOS_TRANSFERENCIA.includes(motivo) ? PARCELA_STATUS.TRANSFERIDA : PARCELA_STATUS.CANCELADA;
    await AtoParcela.update(
        { status: statusParcela },
        { where: { plano_id: plano.id, status: { [Op.in]: [PARCELA_STATUS.PREVISTA, PARCELA_STATUS.ERRO, PARCELA_STATUS.VENCIDA] } } },
    );
    const vivas = await AtoParcela.findAll({
        where: { plano_id: plano.id, status: PARCELA_STATUS.EMITIDA }, attributes: ['id'], raw: true,
    });
    await plano.update({
        status: statusPlano, encerrado_motivo: motivo, encerrado_detalhe: detalhe,
        encerrado_em: new Date(), encerrado_por: userId,
    });
    console.log(`[PARCELAS] Plano ${plano.id} (reserva ${plano.idreserva}) ${statusPlano}: ${motivo}${detalhe ? ` - ${detalhe}` : ''}. ${vivas.length} boleto(s) vivo(s) a baixar.`);
    return { parcelasComBoletoVivo: vivas.map(v => v.id) };
}

const OBS_EXCLUIDO = 'PAUSADO: empreendimento fora da cobranca de parcelas (Configuracoes > Parcelas mensais)';

/**
 * Aplica a lista de empreendimentos excluidos (cfg.empreendimentosExcluidos):
 * plano ATIVO de empreendimento excluido e pausado (boletos ja emitidos ficam
 * valendo; a tela baixa se precisar); plano que ESTA pausado por esta regra e
 * cujo empreendimento saiu da lista volta a ativo. Roda ao salvar a
 * configuracao e no inicio de toda rodada. Idempotente.
 */
export async function aplicarExclusoes(cfg, { userId = null } = {}) {
    const out = { pausados: 0, reativados: 0, boletosVivos: 0, empreendimentos: cfg.empreendimentosExcluidos || [] };
    const vivos = await AtoPlano.findAll({ where: { status: { [Op.in]: [PLANO_STATUS.ATIVO, PLANO_STATUS.PAUSADO] } } });
    for (const plano of vivos) {
        const excluido = empreendimentoExcluido(plano.empreendimento, cfg.empreendimentosExcluidos);
        if (plano.status === PLANO_STATUS.ATIVO && excluido) {
            await plano.update({ status: PLANO_STATUS.PAUSADO, pausado_em: new Date(), pausado_por: userId, observacao: OBS_EXCLUIDO, updated_by: userId });
            out.pausados++;
            out.boletosVivos += await BoletoHistory.count({ where: { idreserva: plano.idreserva, tipo: 'parcela', status: 'success', payment_status: 'pending', ignorado: false } });
        } else if (plano.status === PLANO_STATUS.PAUSADO && !excluido && plano.observacao === OBS_EXCLUIDO) {
            await plano.update({ status: PLANO_STATUS.ATIVO, pausado_em: null, pausado_por: null, observacao: null, updated_by: userId });
            out.reativados++;
        }
    }
    if (out.pausados || out.reativados) console.log(`[PARCELAS] exclusoes por empreendimento: ${out.pausados} pausado(s), ${out.reativados} reativado(s), ${out.boletosVivos} boleto(s) vivo(s) nos pausados.`);
    return out;
}

/**
 * Empreendimentos conhecidos (reservas locais + planos), com quantos planos
 * ativos cada um tem - para a tela escolher quais ficam fora da cobranca.
 */
export async function listarEmpreendimentos() {
    const [rows] = await db.sequelize.query(`
        WITH nomes AS (
            SELECT upper(trim(unidade_json->>'empreendimento')) AS nome FROM reservas WHERE coalesce(unidade_json->>'empreendimento', '') <> ''
            UNION SELECT upper(trim(empreendimento)) FROM ato_planos WHERE coalesce(empreendimento, '') <> ''
        )
        SELECT n.nome,
               (SELECT count(*) FROM ato_planos p WHERE upper(trim(p.empreendimento)) = n.nome AND p.status = 'ativo')::int AS ativos,
               (SELECT count(*) FROM ato_planos p WHERE upper(trim(p.empreendimento)) = n.nome AND p.status = 'pausado')::int AS pausados
          FROM nomes n ORDER BY ativos DESC, n.nome`);
    return { empreendimentos: rows };
}

export async function pausarPlano(plano, userId = null) {
    if (plano.status !== PLANO_STATUS.ATIVO) throw new Error('So um plano ativo pode ser pausado.');
    await plano.update({ status: PLANO_STATUS.PAUSADO, pausado_em: new Date(), pausado_por: userId, updated_by: userId });
    return plano;
}

export async function reativarPlano(plano, userId = null) {
    if (![PLANO_STATUS.PAUSADO, PLANO_STATUS.ENCERRADO].includes(plano.status)) {
        throw new Error('So um plano pausado ou encerrado manualmente pode ser reativado.');
    }
    if (plano.status === PLANO_STATUS.ENCERRADO && plano.encerrado_motivo !== 'manual') {
        throw new Error(`Plano encerrado por "${plano.encerrado_motivo}" nao pode ser reativado pela tela.`);
    }
    // Parcelas que foram marcadas canceladas pelo encerramento manual voltam a previstas.
    await AtoParcela.update(
        { status: PARCELA_STATUS.PREVISTA },
        { where: { plano_id: plano.id, status: PARCELA_STATUS.CANCELADA, boleto_history_id: null } },
    );
    await plano.update({
        status: PLANO_STATUS.ATIVO, pausado_em: null, pausado_por: null,
        encerrado_motivo: null, encerrado_detalhe: null, encerrado_em: null, encerrado_por: null, updated_by: userId,
    });
    return plano;
}

/**
 * Verifica os planos vivos contra o Sienge e a situacao da reserva; encerra o
 * que tiver de encerrar. Devolve o que encerrou e as parcelas com boleto vivo
 * (a rodada baixa em seguida).
 */
export async function verificarEncerramentos(cfg) {
    const planos = await AtoPlano.findAll({ where: { status: { [Op.in]: [PLANO_STATUS.ATIVO, PLANO_STATUS.PAUSADO] } } });
    const encerrados = [];
    for (const plano of planos) {
        try {
            const [contrato, local, repasse] = await Promise.all([contratoSienge(plano.idreserva), carregarReservaLocal(plano.idreserva), repasseAtual(plano.idreserva)]);
            await plano.update({
                sienge_contract_id: contrato?.id || null,
                sienge_venda_faturada_em: contrato?.financial_institution_date || null,
                sienge_verificado_em: new Date(),
                cv_repasse_id: repasse?.idrepasse || null,
                cv_repasse_situacao_id: repasse?.idsituacao_repasse || null,
                cv_repasse_situacao: repasse?.status_repasse || null,
            });
            const motivo = motivoEncerramento({
                contrato,
                encerrarQuandoFaturado: cfg.encerrarQuandoFaturado,
                situacaoMorta: situacaoMortaLocal(local, cfg.situacoesMortas),
                repasseSituacaoId: repasse?.idsituacao_repasse || null,
                encerrarEtapasRepasse: cfg.encerrarEtapasRepasse,
            });
            if (!motivo) continue;
            const detalhe = motivo === 'sienge_faturado'
                ? `contrato Sienge ${contrato.id} faturado como venda em ${contrato.financial_institution_date}`
                : motivo === 'repasse_contrato_emitido'
                    ? `repasse ${repasse.idrepasse} na etapa "${repasse.status_repasse}" (${repasse.idsituacao_repasse}) no CV${repasse.data_status_repasse ? ` desde ${String(repasse.data_status_repasse).slice(0, 10)}` : ''}`
                    : `reserva na situacao "${local?.situacao?.situacao || '?'}" no CV`;
            const { parcelasComBoletoVivo } = await encerrarPlano(plano, motivo, { detalhe });
            encerrados.push({ plano, motivo, detalhe, parcelasComBoletoVivo });
        } catch (err) {
            console.warn(`[PARCELAS] verificarEncerramentos falhou na reserva ${plano.idreserva}: ${err.message}`);
        }
    }
    return encerrados;
}

/**
 * Adesao: reservas com ato pago e sem plano ganham um. Usa a tabela local de
 * reservas (barata); a API do CV so quando a local nao tem a reserva.
 */
export async function aderirPendentes(cfg, { limite = 150, settings = null } = {}) {
    const [rows] = await db.sequelize.query(`
        WITH pago AS (
            SELECT idreserva, max(paid_at) AS paid_at FROM (
                SELECT idreserva, paid_at FROM boleto_history
                 WHERE status = 'success' AND payment_status = 'paid' AND NOT ignorado AND parcela_id IS NULL
                UNION ALL
                SELECT idreserva, paid_at FROM userede_link_history
                 WHERE status = 'success' AND payment_status = 'paid' AND NOT coalesce(ignorado, false)
            ) x GROUP BY idreserva
        )
        SELECT p.idreserva, p.paid_at
          FROM pago p
          LEFT JOIN ato_planos ap ON ap.idreserva = p.idreserva
         WHERE ap.id IS NULL
         ORDER BY p.paid_at DESC NULLS LAST
         LIMIT :limite`, { replacements: { limite } });

    const stats = { candidatas: rows.length, criados: 0, sem_series: 0, canceladas: 0, excluidos: 0, erros: 0 };
    for (const r of rows) {
        try {
            const out = await criarOuSincronizarPlano(r.idreserva, { preferirLocal: true, origem: 'ato_pago', atoPagoEm: r.paid_at, settings });
            if (out.criado) stats.criados++;
            else if (out.skipped === 'sem_series') stats.sem_series++;
            else if (out.skipped === 'reserva_cancelada') stats.canceladas++;
            else if (out.skipped === 'empreendimento_excluido') stats.excluidos++;
        } catch (err) {
            stats.erros++;
            console.warn(`[PARCELAS] adesao falhou na reserva ${r.idreserva}: ${err.message}`);
        }
    }
    return stats;
}

// ── Leitura para a tela ───────────────────────────────────────────────────────

function escopoSql(nomes, f) {
    const cond = [];
    const rep = {};
    if (nomes !== null) {
        cond.push("lower(coalesce(p.empreendimento, '')) IN (:escopo)");
        rep.escopo = nomes.length ? nomes : [''];
    }
    if (f.status) {
        const lista = String(f.status).split(',').map(s => s.trim()).filter(Boolean);
        if (lista.length) { cond.push('p.status IN (:status)'); rep.status = lista; }
    }
    if (f.empreendimento) {
        const lista = String(f.empreendimento).split(',').map(s => s.trim()).filter(Boolean);
        if (lista.length) { cond.push('p.empreendimento IN (:emps)'); rep.emps = lista; }
    }
    if (f.idreserva) { cond.push('p.idreserva = :idreserva'); rep.idreserva = Number(f.idreserva); }
    if (f.q) {
        cond.push(`(unaccent(lower(coalesce(p.titular_nome, ''))) LIKE unaccent(lower(:q)) OR CAST(p.idreserva AS text) LIKE :q)`);
        rep.q = `%${String(f.q).trim()}%`;
    }
    return { where: cond.length ? `WHERE ${cond.join(' AND ')}` : '', rep };
}

const AGREGADO = `
    SELECT p.*,
           count(x.id)::int                                                   AS parcelas_total,
           count(x.id) FILTER (WHERE x.status = 'paga')::int                  AS parcelas_pagas,
           count(x.id) FILTER (WHERE x.status = 'emitida')::int               AS parcelas_emitidas,
           count(x.id) FILTER (WHERE x.status = 'vencida')::int               AS parcelas_vencidas,
           count(x.id) FILTER (WHERE x.status = 'prevista')::int              AS parcelas_previstas,
           count(x.id) FILTER (WHERE x.status = 'erro')::int                  AS parcelas_erro,
           count(x.id) FILTER (WHERE x.status IN ('emitida') AND x.vencimento_cobrado < CURRENT_DATE)::int AS parcelas_emitidas_vencidas,
           -- Prevista que ja passou do vencimento e nunca foi cobrada: e o
           -- caixa parado que motivou o modulo, conta como atraso tambem.
           count(x.id) FILTER (WHERE x.status IN ('prevista','erro') AND x.vencimento < CURRENT_DATE)::int AS parcelas_previstas_vencidas,
           coalesce(sum(x.valor) FILTER (WHERE x.status = 'paga'), 0)::numeric               AS valor_pago,
           coalesce(sum(coalesce(x.valor_cobrado, x.valor)) FILTER (WHERE x.status = 'vencida' OR (x.status = 'emitida' AND x.vencimento_cobrado < CURRENT_DATE) OR (x.status IN ('prevista','erro') AND x.vencimento < CURRENT_DATE)), 0)::numeric AS valor_atraso,
           coalesce(sum(x.valor) FILTER (WHERE x.status IN ('prevista','emitida','vencida','erro')), 0)::numeric AS valor_aberto,
           min(x.vencimento) FILTER (WHERE x.status IN ('prevista','erro'))   AS proxima_vencimento,
           min(x.numero) FILTER (WHERE x.status IN ('prevista','erro'))       AS proxima_numero,
           min(x.vencimento_cobrado) FILTER (WHERE x.status = 'emitida')      AS emitida_vencimento
      FROM ato_planos p
      LEFT JOIN ato_parcelas x ON x.plano_id = p.id`;

const ORDENAVEIS = {
    reserva: 'p.idreserva', titular: 'p.titular_nome', empreendimento: 'p.empreendimento',
    status: 'p.status', proxima: 'proxima_vencimento', atraso: 'valor_atraso', criado: 'p.created_at',
};

/** Lista de planos com agregados das parcelas (uma linha por reserva). */
export async function listarPlanos(user, f = {}) {
    const nomes = await allowedEnterpriseNames(user);
    const { where, rep } = escopoSql(nomes, f);
    const page = Math.max(1, Number(f.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(f.limit) || 50));
    const coluna = ORDENAVEIS[f.sortBy] || 'proxima_vencimento';
    const dir = String(f.sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const having = f.comAtraso === '1' || f.comAtraso === true
        ? `HAVING count(x.id) FILTER (WHERE x.status = 'vencida' OR (x.status = 'emitida' AND x.vencimento_cobrado < CURRENT_DATE) OR (x.status IN ('prevista','erro') AND x.vencimento < CURRENT_DATE)) > 0`
        : '';
    const base = `${AGREGADO} ${where} GROUP BY p.id ${having}`;
    const [[{ total }]] = await db.sequelize.query(`SELECT count(*)::int AS total FROM (${base}) t`, { replacements: rep });
    const [rows] = await db.sequelize.query(
        `SELECT * FROM (${base}) t ORDER BY ${coluna} ${dir} NULLS LAST, idreserva DESC LIMIT :limit OFFSET :offset`,
        { replacements: { ...rep, limit, offset: (page - 1) * limit } },
    );
    for (const r of rows) {
        if (typeof r.divergencias === 'string') { try { r.divergencias = JSON.parse(r.divergencias); } catch { r.divergencias = null; } }
    }
    return { total, page, limit, rows };
}

/** KPIs da aba, no mesmo escopo da lista. */
export async function estatisticas(user, f = {}) {
    const nomes = await allowedEnterpriseNames(user);
    const { where, rep } = escopoSql(nomes, { ...f, status: undefined });
    const [[k]] = await db.sequelize.query(`
        WITH pl AS (SELECT p.* FROM ato_planos p ${where})
        SELECT
            count(DISTINCT pl.id) FILTER (WHERE pl.status = 'ativo')::int                      AS planos_ativos,
            count(DISTINCT pl.id) FILTER (WHERE pl.status = 'pausado')::int                    AS planos_pausados,
            count(DISTINCT pl.id) FILTER (WHERE pl.status = 'encerrado')::int                  AS planos_encerrados,
            count(DISTINCT pl.id) FILTER (WHERE pl.status = 'cancelado')::int                  AS planos_cancelados,
            count(x.id) FILTER (WHERE x.status = 'prevista' AND pl.status = 'ativo' AND x.vencimento <= CURRENT_DATE + 30)::int AS a_vencer_30_qty,
            coalesce(sum(x.valor) FILTER (WHERE x.status = 'prevista' AND pl.status = 'ativo' AND x.vencimento <= CURRENT_DATE + 30), 0)::numeric AS a_vencer_30_valor,
            count(x.id) FILTER (WHERE x.status = 'emitida')::int                                AS emitidas_qty,
            coalesce(sum(coalesce(x.valor_cobrado, x.valor)) FILTER (WHERE x.status = 'emitida'), 0)::numeric AS emitidas_valor,
            count(x.id) FILTER (WHERE x.status = 'vencida' OR (x.status = 'emitida' AND x.vencimento_cobrado < CURRENT_DATE) OR (x.status IN ('prevista','erro') AND pl.status = 'ativo' AND x.vencimento < CURRENT_DATE))::int AS atraso_qty,
            coalesce(sum(coalesce(x.valor_cobrado, x.valor)) FILTER (WHERE x.status = 'vencida' OR (x.status = 'emitida' AND x.vencimento_cobrado < CURRENT_DATE) OR (x.status IN ('prevista','erro') AND pl.status = 'ativo' AND x.vencimento < CURRENT_DATE)), 0)::numeric AS atraso_valor,
            count(x.id) FILTER (WHERE x.status IN ('prevista','erro') AND pl.status = 'ativo' AND x.vencimento < CURRENT_DATE)::int AS nunca_cobradas_qty,
            count(x.id) FILTER (WHERE x.status = 'paga' AND x.pago_em >= CURRENT_DATE - 30)::int AS pagas_30_qty,
            coalesce(sum(coalesce(x.valor_cobrado, x.valor)) FILTER (WHERE x.status = 'paga' AND x.pago_em >= CURRENT_DATE - 30), 0)::numeric AS pagas_30_valor,
            count(x.id) FILTER (WHERE x.status = 'paga')::int                                   AS pagas_qty,
            coalesce(sum(coalesce(x.valor_cobrado, x.valor)) FILTER (WHERE x.status = 'paga'), 0)::numeric AS pagas_valor,
            count(x.id) FILTER (WHERE x.status = 'erro')::int                                   AS erro_qty,
            count(x.id) FILTER (WHERE x.status = 'transferida')::int                            AS transferidas_qty
          FROM pl LEFT JOIN ato_parcelas x ON x.plano_id = pl.id`, { replacements: rep });
    const n = (v) => Number(v) || 0;
    return {
        planos: { ativos: n(k.planos_ativos), pausados: n(k.planos_pausados), encerrados: n(k.planos_encerrados), cancelados: n(k.planos_cancelados) },
        aVencer30: { qty: n(k.a_vencer_30_qty), valor: n(k.a_vencer_30_valor) },
        emitidas: { qty: n(k.emitidas_qty), valor: n(k.emitidas_valor) },
        atraso: { qty: n(k.atraso_qty), valor: n(k.atraso_valor), nuncaCobradas: n(k.nunca_cobradas_qty) },
        pagas30: { qty: n(k.pagas_30_qty), valor: n(k.pagas_30_valor) },
        pagas: { qty: n(k.pagas_qty), valor: n(k.pagas_valor) },
        erro: { qty: n(k.erro_qty) },
        transferidas: { qty: n(k.transferidas_qty) },
    };
}

/** Facetas para os filtros (empreendimentos com plano). */
export async function facetas(user) {
    const nomes = await allowedEnterpriseNames(user);
    const { where, rep } = escopoSql(nomes, {});
    const [emps] = await db.sequelize.query(
        `SELECT p.empreendimento AS name, count(*)::int AS qty FROM ato_planos p ${where}
          ${where ? 'AND' : 'WHERE'} p.empreendimento IS NOT NULL GROUP BY p.empreendimento ORDER BY 1`,
        { replacements: rep },
    );
    return { empreendimentos: emps };
}

/** Plano + parcelas + boletos (para o modal). */
export async function detalhePlano(user, idreserva) {
    const nomes = await allowedEnterpriseNames(user);
    const plano = await AtoPlano.findOne({ where: { idreserva: Number(idreserva) } });
    if (!plano) return null;
    if (nomes !== null && !nomes.includes(String(plano.empreendimento || '').toLowerCase())) return null;
    const parcelas = await AtoParcela.findAll({ where: { plano_id: plano.id }, order: [['numero', 'ASC']] });
    const boletos = await BoletoHistory.findAll({
        where: { parcela_id: { [Op.in]: parcelas.map(p => p.id).concat([-1]) } },
        order: [['id', 'ASC']],
        attributes: ['id', 'parcela_id', 'status', 'payment_status', 'valor', 'vencimento', 'nosso_numero', 'boleto_supabase_url',
            'created_at', 'paid_at', 'cancelled_at', 'error_message', 'cliente_email_enviado', 'cliente_whatsapp_enviado', 'cv_documento_anexado', 'last_check_situation'],
    });
    const contrato = await contratoSienge(plano.idreserva);
    return { plano, parcelas, boletos, contrato, hoje: hojeYmd() };
}

// ── Acompanhamento: rodadas e boletos de parcela ──────────────────────────────

/** Ultimas rodadas do ciclo (automaticas e manuais), mais recente primeiro. */
export async function listarRodadas(user, { limit = 30 } = {}) {
    const rows = await db.AtoParcelaRodada.findAll({
        order: [['inicio', 'DESC']],
        limit: Math.min(Math.max(Number(limit) || 30, 1), 200),
    });
    const ids = [...new Set(rows.map(r => r.user_id).filter(Boolean))];
    const nomes = ids.length ? await db.User.findAll({ where: { id: ids }, attributes: ['id', 'username'] }) : [];
    const nome = Object.fromEntries(nomes.map(u => [u.id, u.username]));
    return rows.map(r => ({ ...r.get({ plain: true }), user_nome: r.user_id ? (nome[r.user_id] || null) : null }));
}

/**
 * Boletos de PARCELA emitidos (ou que falharam) num periodo, com o canal de
 * cada um e o motivo quando nao saiu. E o "boleto a boleto" da aba Parcelas.
 * Periodo pela data de Brasilia da emissao: hoje | 7d | 30d | dia=YYYY-MM-DD.
 */
export async function listarBoletosParcela(user, f = {}) {
    const nomes = await allowedEnterpriseNames(user);
    const cond = ["h.tipo = 'parcela'"];
    const rep = { limit: Math.min(Math.max(Number(f.limit) || 500, 1), 2000) };
    if (nomes !== null) {
        cond.push("lower(coalesce(p.empreendimento, h.empreendimento, '')) IN (:escopo)");
        rep.escopo = nomes.length ? nomes : [''];
    }
    const hoje = hojeYmd();
    const dias = { hoje: 0, '7d': 6, '30d': 29 };
    if (f.dia && /^\d{4}-\d{2}-\d{2}$/.test(String(f.dia))) {
        cond.push("(h.created_at AT TIME ZONE 'America/Sao_Paulo')::date = :dia"); rep.dia = String(f.dia);
    } else {
        const n = dias[f.periodo] ?? 0;
        cond.push("(h.created_at AT TIME ZONE 'America/Sao_Paulo')::date >= :de"); rep.de = addDays(hoje, -n);
    }
    if (f.status && ['success', 'error', 'processing'].includes(String(f.status))) { cond.push('h.status = :st'); rep.st = String(f.status); }
    if (f.q) {
        const q = String(f.q).trim();
        if (/^\d+$/.test(q)) { cond.push('h.idreserva = :qn'); rep.qn = Number(q); }
        else { cond.push('h.titular_nome ILIKE :q'); rep.q = `%${q}%`; }
    }
    const [rows] = await db.sequelize.query(`
        SELECT h.id, h.idreserva, h.parcela_id, h.status, h.payment_status, h.titular_nome, h.empreendimento,
               h.valor, h.vencimento, h.nosso_numero, h.error_message, h.warnings, h.boleto_supabase_url,
               h.cliente_email_enviado, h.cliente_whatsapp_enviado, h.cv_documento_anexado,
               h.created_at, h.paid_at, h.cancelled_at,
               x.numero, x.total, x.status AS parcela_status, x.emissoes,
               p.unidade, p.status AS plano_status, p.cadastro_alerta,
               (SELECT e.message FROM boleto_events e WHERE e.boleto_history_id = h.id AND e.type = 'client_whatsapp_skipped' ORDER BY e.id DESC LIMIT 1) AS whatsapp_motivo,
               (SELECT e.message FROM boleto_events e WHERE e.boleto_history_id = h.id AND e.type = 'client_email_skipped' ORDER BY e.id DESC LIMIT 1) AS email_motivo,
               (SELECT e.message FROM boleto_events e WHERE e.boleto_history_id = h.id AND e.type = 'cv_attach_failed' ORDER BY e.id DESC LIMIT 1) AS cv_anexo_motivo
          FROM boleto_history h
          LEFT JOIN ato_parcelas x ON x.id = h.parcela_id
          LEFT JOIN ato_planos p ON p.id = x.plano_id
         WHERE ${cond.join(' AND ')}
         ORDER BY h.id DESC
         LIMIT :limit`, { replacements: rep });
    const resumo = { total: rows.length, sucesso: 0, erro: 0, processando: 0, whatsapp_nao_enviado: 0, email_nao_enviado: 0, cv_nao_anexado: 0, pagos: 0, cep_contingencia: 0 };
    for (const r of rows) {
        if (r.status === 'success') resumo.sucesso++;
        else if (r.status === 'error') resumo.erro++;
        else resumo.processando++;
        const avisos = Array.isArray(r.warnings) ? r.warnings : [];
        r.cep_contingencia = avisos.find(w => w?.etapa === 'cep_contingencia')?.erro || null;
        if (r.status === 'success') {
            if (!r.cliente_whatsapp_enviado) resumo.whatsapp_nao_enviado++;
            if (!r.cliente_email_enviado) resumo.email_nao_enviado++;
            if (!r.cv_documento_anexado) resumo.cv_nao_anexado++;
            if (r.payment_status === 'paid') resumo.pagos++;
            if (r.cep_contingencia) resumo.cep_contingencia++;
        }
    }
    return { rows, resumo, hoje };
}

export default {
    getSettings, cfgParcelas, carregarReservaCv, carregarReservaDoPlano, criarPlanoTeste, atoPago, contratoSienge,
    criarOuSincronizarPlano, editarParcela, encerrarPlano, pausarPlano, reativarPlano,
    verificarEncerramentos, aderirPendentes, listarPlanos, estatisticas, facetas, detalhePlano,
    listarRodadas, listarBoletosParcela, repasseAtual, listarEtapasRepasse,
    _internal: { reservaCanceladaCv, situacaoMortaLocal, diffDays },
};

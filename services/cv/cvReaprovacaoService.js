// services/cv/cvReaprovacaoService.js
//
// Reaprovação automática de reservas no CV.
//
// O problema: no CV, a aprovação automática nativa só roda quando a reserva é
// CRIADA. Qualquer edição da condição tira a aprovação (opção "Remover a
// aprovação... caso alguma informação seja alterada", ligada em 21
// empreendimentos em 15/10/2026), e ela só volta com o clique de um aprovador
// no painel - mesmo quando a condição editada voltou para dentro da regra.
// Aprovar não tem API (v1/v2/v3 e documentação varridas em 15/10/2026); é o
// formulário de "Comparar e aprovar" do painel.
//
// O que este serviço faz, a cada rodada do cron do robô:
//  1. pega no espelho as reservas nas situações configuradas (Análise
//     Comercial, Ajustes Financeiro, Ajustes);
//  2. confirma ao vivo pela API v1 que a reserva continua lá e sem aprovação;
//  3. lê no PAINEL a regra e as séries do empreendimento (a regra mora no CV,
//     o Office não tem uma segunda cópia) e a tela de comparação da reserva;
//  4. confere a condição contra a regra; dentro dela, aprova pelo mesmo
//     formulário do botão Aprovar e confirma pela API que ficou aprovada.
//
// Conservador de propósito: qualquer coisa que o robô não saiba avaliar
// (campo de regra que ainda não lê, base de comparação diferente, série que
// fecha o total por dentro) deixa a reserva para o aprovador humano e diz
// por quê. Errar para o lado do manual custa um clique; aprovar errado custa
// um contrato.

import crypto from 'crypto';
import * as cheerio from 'cheerio';
import db from '../../models/sequelize/index.js';
import apiCv from '../../lib/apiCv.js';
import { ensureCvRoboSchema, COMENTARIO_PADRAO } from '../../lib/ensureCvRoboSchema.js';
import { cookieAtivo, getPainel, postPainel, painelAtual } from '../../lib/cvPainelSessao.js';

// Campos da regra do CV que o robô ainda NÃO avalia. Preenchido num
// empreendimento = reserva fica no manual, com o nome do campo no motivo.
const CAMPOS_NAO_AVALIADOS = {
    simulacao_valor: 'valor mínimo do VGV',
    valor_maximo_vgv: 'valor máximo do VGV',
    valor_minimo_pv: 'valor mínimo do PV',
    valor_maximo_pv: 'valor máximo do PV',
    simulacao_valor_ato: 'valor limite mínimo de atos',
    simulacao_limite_atos: 'limite de atos',
    simulacao_limite_atos_minimo: 'limite mínimo de atos',
    limite_atos_maximo_porcentagem: 'limite máximo de atos (%)',
    simulacao_limite_atos_minimo_porcentagem: 'limite mínimo de atos (%)',
    simulacao_data_maxima_parcela: 'data máxima da parcela',
    qtd_dias_minimo_vencimento_ato: 'dias mínimos para vencer o ato',
    qtd_dias_maximo_vencimento_ato: 'dias máximos para vencer o ato',
    qtd_parcelas_minima: 'quantidade mínima de parcelas',
    simulacao_qtd_parcelas: 'quantidade máxima de parcelas',
    porcentagem_minima_financiamento: 'porcentagem mínima do financiamento',
    simulacao_porcentagem_maxima_financiamento: 'porcentagem máxima do financiamento',
    simulacao_valor_total_prosoluto: 'valor limite do pró-soluto',
    percentual_minimo_prosoluto: 'porcentagem mínima do pró-soluto',
};

const SERIE_MAX_SEM_LIMITE = 999999.99;   // como "sem máximo" foi gravado no CV

/** "235.000,00" -> 235000 ; "" -> null */
export function numeroBR(txt) {
    const s = String(txt ?? '').replace(/[^\d,.-]/g, '');
    if (!s) return null;
    const n = Number(s.replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
}

const temValor = (v) => {
    const n = numeroBR(v);
    if (n !== null) return n !== 0;
    return String(v ?? '').trim() !== '';
};

function camposDoForm($, form) {
    const out = {};
    $(form).find('input, select, textarea').each((_, el) => {
        const $el = $(el);
        const nome = $el.attr('name');
        if (!nome) return;
        const tipo = String($el.attr('type') || '').toLowerCase();
        if (tipo === 'submit' || tipo === 'button') return;
        if (tipo === 'checkbox' || tipo === 'radio') {
            if ($el.attr('checked') !== undefined) out[nome] = $el.attr('value') ?? 'on';
            return;
        }
        if (el.tagName === 'select') {
            const sel = $el.find('option[selected]').first();
            out[nome] = sel.length ? (sel.attr('value') ?? sel.text()) : ($el.find('option').first().attr('value') ?? '');
            return;
        }
        if (el.tagName === 'textarea') { out[nome] = $el.text(); return; }
        out[nome] = $el.attr('value') ?? '';
    });
    return out;
}

// ── Regra do empreendimento, lida do painel ──────────────────────────────────

async function lerRegraDoEmpreendimento(idempreendimento) {
    const p = await painelAtual();
    const base = `/${p}/cadastros/empreendimentos/${idempreendimento}`;

    const htmlCfg = await getPainel(`${base}/configuracoes`, (h) => /name="aprovacao_automatica"/.test(h));
    const $c = cheerio.load(htmlCfg);
    const automatica = $c('[name="aprovacao_automatica"]').attr('checked') !== undefined;

    const htmlRegra = await getPainel(`${base}/reservas_simulacoes_regras`, (h) => /funcionalidades_regras/.test(h));
    const $r = cheerio.load(htmlRegra);
    const formRegra = $r('form').filter((_, f) => $r(f).find('[name="funcionalidades_regras"]').length > 0).first();
    const regra = camposDoForm($r, formRegra);

    const htmlSeries = await getPainel(`${base}/reservas_simulacoes_series`, (h) => /idserie\[\]/.test(h));
    const $s = cheerio.load(htmlSeries);
    const series = {};
    $s('table tbody tr').each((_, tr) => {
        const $tr = $s(tr);
        const id = Number($tr.find('td').first().text().trim());
        if (!Number.isInteger(id) || id <= 0) return;
        const v = (nome) => numeroBR($tr.find(`[name^="${nome}"]`).first().attr('value'));
        series[id] = {
            nome: $tr.find('td').eq(1).text().replace(/\s+/g, ' ').trim(),
            valor_min: v('valor_minimo'),
            valor_max: v('valor['),
            parcelas_min: v('parcela_minimo'),
            parcelas_max: v('parcela['),
            renda_pct: v('porcentagem_renda'),
        };
    });

    return { automatica, regra, series };
}

// ── Tela de comparação da reserva ────────────────────────────────────────────

async function lerComparacao(idreserva) {
    const p = await painelAtual();
    const caminho = `/${p}/comercial/reservas/${idreserva}/index_condicao_pagamento/aprovar`;
    const html = await getPainel(caminho, (h) => /form_aprovar_min|Reserva j[áa] aprovada|Compara[çc][ãa]o com a tabela/i.test(h));
    const $ = cheerio.load(html);
    $('script, style').remove();
    const texto = $('body').text().replace(/\s+/g, ' ');

    const form = $('form').filter((_, f) => $(f).find('[name="form_aprovar_min"]').length > 0).first();
    const contratos = [...texto.matchAll(/Valor do contrato:\s*R\$\s*([\d.,]+)/gi)].map((m) => numeroBR(m[1]));
    const renda = numeroBR(texto.match(/Renda Total\s*R\$\s*([\d.,]+)/i)?.[1]);

    return {
        caminho,
        jaAprovada: /Reserva j[áa] aprovada/i.test(texto),
        temForm: form.length > 0,
        campos: form.length ? camposDoForm($, form) : null,
        acaoForm: form.attr('action') || null,
        vgvProposta: contratos[0] ?? null,
        vgvTabela: contratos[1] ?? null,
        renda,
    };
}

// ── A conferência ────────────────────────────────────────────────────────────

/**
 * Confere a condição contra a regra. Devolve { ok, motivos[], detalhes }.
 * Função pura: recebe tudo já lido, para dar para testar sem CV.
 */
export function avaliar({ regraEmp, comparacao, condicoes, rendaApi, cfg }) {
    const motivos = [];
    const det = {};
    const { regra, series, automatica } = regraEmp;

    if (!automatica) motivos.push('o empreendimento não tem a aprovação automática ligada no CV');
    if (!['R', 'A'].includes(String(regra.funcionalidades_regras || ''))) {
        motivos.push('a regra do empreendimento no CV não vale para reserva');
    }

    for (const [campo, rotulo] of Object.entries(CAMPOS_NAO_AVALIADOS)) {
        if (temValor(regra[campo])) motivos.push(`a regra usa "${rotulo}", que o robô ainda não avalia`);
    }
    if (String(regra.simulacao_bloquear_por_quantidade || 'N') === 'S') {
        motivos.push('a regra bloqueia por quantidade de parcelas, que o robô ainda não avalia');
    }
    if (String(regra.tabela_aprovacao_gestor || 'TB') !== 'TB') motivos.push('a regra compara com a tabela mínima, que o robô ainda não avalia');
    if (String(regra.simulacao_calculo_usar_no_desconto || 'V') !== 'V') motivos.push('a regra compara pelo VP, e o robô só compara pelo VGV');

    // Desconto aceito: o menor entre os perfis com aprovação automática ligada.
    // O robô não sabe quem vai assinar a mudança, então fica com o mais estrito.
    const pcts = [
        ['simulacao_aprovacao_automatica_corretor', 'simulacao_porcentagem_aprovacao_corretor'],
        ['simulacao_aprovacao_imobiliaria', 'simulacao_porcentagem_aprovacao_imobiliaria'],
        ['aprovacao_gestor', 'porcentagem_aprovacao_gestor'],
    ].filter(([liga]) => String(regra[liga] || '') === 'S').map(([, pct]) => numeroBR(regra[pct]) ?? 0);
    if (!pcts.length) motivos.push('a regra não tem aprovação automática para nenhum perfil');
    const descontoPct = pcts.length ? Math.min(...pcts) : 0;
    det.desconto_aceito_pct = descontoPct;

    // 1) Valor contra a tabela (base VGV).
    const { vgvProposta, vgvTabela } = comparacao;
    det.vgv_proposta = vgvProposta;
    det.vgv_tabela = vgvTabela;
    if (!vgvProposta || !vgvTabela) {
        motivos.push('a tela de comparação do CV não trouxe o valor da proposta e o da tabela (sem tabela vigente?)');
    } else {
        const piso = vgvTabela * (1 - descontoPct / 100) - Number(cfg.tolerancia_reais || 0);
        det.vgv_piso = Math.round(piso * 100) / 100;
        if (vgvProposta < piso) {
            motivos.push(`o valor da proposta (R$ ${vgvProposta.toFixed(2)}) ficou abaixo do aceito pela regra (R$ ${piso.toFixed(2)})`);
        }
    }

    // 2) Séries que mandam para o manual.
    const bloqueiam = new Set((cfg.series_bloqueiam || []).map(Number));
    const presentes = [...new Set(condicoes.map((c) => Number(c.idserie)))];
    for (const id of presentes) {
        const nome = series[id]?.nome || condicoes.find((c) => Number(c.idserie) === id)?.nome || `série ${id}`;
        if (bloqueiam.has(id)) motivos.push(`a condição tem a série ${nome}, configurada para ir ao aprovador`);
    }

    // 3) Limites de cada série configurada no empreendimento.
    const renda = Number(rendaApi || comparacao.renda || 0) || null;
    det.renda = renda;
    for (const [idTxt, lim] of Object.entries(series)) {
        const id = Number(idTxt);
        const linhas = condicoes.filter((c) => Number(c.idserie) === id);
        if (!linhas.length) continue;
        const nome = lim.nome || `série ${id}`;
        const qtd = linhas.reduce((s, c) => s + Number(c.quantidade || 0), 0);
        for (const c of linhas) {
            const v = Number(c.valor || 0);
            if (lim.valor_min && v + 0.005 < lim.valor_min) motivos.push(`${nome}: parcela de R$ ${v.toFixed(2)} abaixo do mínimo de R$ ${lim.valor_min.toFixed(2)}`);
            if (lim.valor_max && lim.valor_max < SERIE_MAX_SEM_LIMITE && v - 0.005 > lim.valor_max) motivos.push(`${nome}: parcela de R$ ${v.toFixed(2)} acima do máximo de R$ ${lim.valor_max.toFixed(2)}`);
        }
        if (lim.parcelas_max && qtd > lim.parcelas_max) motivos.push(`${nome}: ${qtd} parcelas, acima do máximo de ${lim.parcelas_max}`);
        if (lim.parcelas_min && qtd < lim.parcelas_min) motivos.push(`${nome}: ${qtd} parcelas, abaixo do mínimo de ${lim.parcelas_min}`);
        if (lim.renda_pct) {
            const maior = Math.max(...linhas.map((c) => Number(c.valor || 0)));
            if (!renda) motivos.push(`${nome}: a regra limita a parcela a ${lim.renda_pct}% da renda, e a reserva não tem renda informada`);
            else if (maior - 0.005 > renda * lim.renda_pct / 100) {
                motivos.push(`${nome}: parcela de R$ ${maior.toFixed(2)} passa de ${lim.renda_pct}% da renda (R$ ${(renda * lim.renda_pct / 100).toFixed(2)})`);
            }
        }
    }

    // 4) Pró-soluto máximo sobre o VGV.
    const psMax = numeroBR(regra.simulacao_percentual_total_prosoluto);
    if (psMax) {
        if (String(regra.simulacao_comparador_prosoluto || 'V') !== 'V') {
            motivos.push('a regra mede o pró-soluto pelo VP, e o robô só mede pelo VGV');
        } else if (vgvProposta) {
            const ps = new Set((cfg.series_pro_soluto || []).map(Number));
            const total = condicoes.filter((c) => ps.has(Number(c.idserie)))
                .reduce((s, c) => s + Number(c.subtotal ?? (Number(c.valor || 0) * Number(c.quantidade || 0))), 0);
            const pct = (total / vgvProposta) * 100;
            det.pro_soluto = { total: Math.round(total * 100) / 100, pct: Math.round(pct * 100) / 100, max: psMax };
            if (pct - 0.005 > psMax) motivos.push(`pró-soluto de ${pct.toFixed(2)}% do VGV, acima do máximo de ${psMax}%`);
        }
    }

    return { ok: motivos.length === 0, motivos, detalhes: det };
}

// ── Configuração e histórico ─────────────────────────────────────────────────

export async function lerConfig() {
    await ensureCvRoboSchema();
    const [rows] = await db.sequelize.query('SELECT * FROM cv_reaprovacao_settings WHERE id = 1');
    const c = rows[0] || {};
    return {
        ativo: !!c.ativo,
        modo: c.modo === 'aprovar' ? 'aprovar' : 'simular',
        situacoes: Array.isArray(c.situacoes) ? c.situacoes.map(Number) : [],
        series_pro_soluto: Array.isArray(c.series_pro_soluto) ? c.series_pro_soluto.map(Number) : [],
        series_bloqueiam: Array.isArray(c.series_bloqueiam) ? c.series_bloqueiam.map(Number) : [],
        tolerancia_reais: Number(c.tolerancia_reais ?? 1),
        max_por_rodada: Number(c.max_por_rodada || 40),
        comentario: c.comentario || COMENTARIO_PADRAO,
        updated_at: c.updated_at || null,
    };
}

export async function salvarConfig(patch, user) {
    await ensureCvRoboSchema();
    const campos = Object.keys(patch);
    if (!campos.length) return lerConfig();
    const jsonb = new Set(['situacoes', 'series_pro_soluto', 'series_bloqueiam']);
    const sets = campos.map((c) => (jsonb.has(c) ? `${c} = CAST(:${c} AS jsonb)` : `${c} = :${c}`)).join(', ');
    const rep = { ...patch, updated_by: user?.id || null };
    for (const c of campos) if (jsonb.has(c)) rep[c] = JSON.stringify(patch[c]);
    await db.sequelize.query(`UPDATE cv_reaprovacao_settings SET ${sets}, updated_by = :updated_by, updated_at = NOW() WHERE id = 1`, { replacements: rep });
    return lerConfig();
}

async function registrar(reserva, decisao, motivos = [], detalhes = null) {
    const assinatura = crypto.createHash('sha1').update(`${decisao}|${JSON.stringify(motivos)}`).digest('hex');
    // Uma linha por MUDANÇA: a mesma reserva fora da regra pelo mesmo motivo a
    // cada 4 minutos encheria o histórico de repetição.
    const [ult] = await db.sequelize.query(
        'SELECT assinatura FROM cv_reaprovacao_log WHERE idreserva = :id ORDER BY created_at DESC LIMIT 1',
        { replacements: { id: reserva.idreserva } }
    );
    if (ult[0]?.assinatura === assinatura && decisao !== 'aprovada') return false;
    await db.sequelize.query(`
        INSERT INTO cv_reaprovacao_log (idreserva, idempreendimento, empreendimento, situacao, decisao, motivos, detalhes, assinatura)
        VALUES (:idreserva, :idempreendimento, :empreendimento, :situacao, :decisao, CAST(:motivos AS jsonb), CAST(:detalhes AS jsonb), :assinatura)
    `, {
        replacements: {
            idreserva: reserva.idreserva,
            idempreendimento: reserva.idempreendimento || null,
            empreendimento: reserva.empreendimento || null,
            situacao: reserva.situacao || null,
            decisao,
            motivos: JSON.stringify(motivos),
            detalhes: detalhes ? JSON.stringify(detalhes) : null,
            assinatura,
        },
    });
    return true;
}

export async function historico({ limite = 60 } = {}) {
    await ensureCvRoboSchema();
    const [rows] = await db.sequelize.query(`
        SELECT id, idreserva, idempreendimento, empreendimento, situacao, decisao, motivos, detalhes, created_at
          FROM cv_reaprovacao_log ORDER BY created_at DESC LIMIT :limite
    `, { replacements: { limite: Math.min(Math.max(Number(limite) || 60, 1), 300) } });
    const [cont] = await db.sequelize.query(`
        SELECT decisao, COUNT(*)::int AS n FROM cv_reaprovacao_log
         WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY decisao
    `);
    return { itens: rows, ultimos7dias: Object.fromEntries(cont.map((c) => [c.decisao, c.n])) };
}

// ── Aprovar ─────────────────────────────────────────────────────────────────

async function reservaAoVivo(idreserva) {
    const { data } = await apiCv.get(`/v1/comercial/reservas/${idreserva}`);
    const r = data?.[String(idreserva)] ?? (Array.isArray(data) ? data[0] : data);
    return r || null;
}

async function aprovarNoPainel(idreserva, comparacao, comentario) {
    const campos = Object.entries(comparacao.campos || {})
        // Comentário vai só como registro interno: nada de e-mail ou aviso
        // para corretor e imobiliária a cada aprovação do robô.
        .filter(([k]) => !/^comentario_(exibir|enviar|salvar)/.test(k))
        .map(([k, v]) => [k, k === 'acao' ? 'aprovarReserva' : k === 'comentario' ? comentario : v]);
    if (!campos.some(([k]) => k === 'acao')) campos.push(['acao', 'aprovarReserva']);
    if (!campos.some(([k]) => k === 'comentario')) campos.push(['comentario', comentario]);

    const p = await painelAtual();
    const alvo = comparacao.acaoForm && comparacao.acaoForm.startsWith('/')
        ? comparacao.acaoForm.replace(/[?#].*$/, '')
        : `/${p}/comercial/reservas/${idreserva}/index_condicao_pagamento`;
    return postPainel(alvo, campos, comparacao.caminho);
}

/**
 * Uma rodada. `forcarSimulacao` deixa a tela testar sem aprovar nada, mesmo
 * com o modo "aprovar" ligado.
 */
export async function rodar({ forcarSimulacao = false } = {}) {
    await ensureCvRoboSchema();
    const cfg = await lerConfig();
    if (!cfg.ativo && !forcarSimulacao) return { pulado: 'reaprovação desligada' };
    if (!(await cookieAtivo())) return { pulado: 'robô sem sessão no painel' };
    if (!cfg.situacoes.length) return { pulado: 'nenhuma situação configurada' };

    const modo = forcarSimulacao ? 'simular' : cfg.modo;
    const [candidatos] = await db.sequelize.query(`
        SELECT idreserva, idempreendimento_cv AS idempreendimento, empreendimento,
               situacao->>'situacao' AS situacao
          FROM reservas
         WHERE (situacao->>'idsituacao')::int IN (:situacoes)
         ORDER BY updated_at DESC
         LIMIT :lim
    `, { replacements: { situacoes: cfg.situacoes, lim: cfg.max_por_rodada } });

    const regras = new Map();
    const resumo = { candidatos: candidatos.length, ja_aprovadas: 0, fora_da_regra: 0, simuladas: 0, aprovadas: 0, erros: 0 };

    for (const c of candidatos) {
        try {
            const viva = await reservaAoVivo(c.idreserva);
            if (!viva) continue;
            const idSit = Number(viva.situacao?.idsituacao);
            if (!cfg.situacoes.includes(idSit)) continue;           // espelho atrasado
            if (String(viva.condicao_aprovada || '').toUpperCase() === 'S') { resumo.ja_aprovadas++; continue; }

            const reserva = {
                idreserva: c.idreserva,
                idempreendimento: Number(viva.unidade?.idempreendimento_cv || c.idempreendimento) || null,
                empreendimento: viva.unidade?.empreendimento || c.empreendimento,
                situacao: viva.situacao?.situacao || c.situacao,
            };
            if (!reserva.idempreendimento) {
                await registrar(reserva, 'ignorada', ['a reserva não informa o empreendimento']);
                continue;
            }

            if (!regras.has(reserva.idempreendimento)) regras.set(reserva.idempreendimento, await lerRegraDoEmpreendimento(reserva.idempreendimento));
            const regraEmp = regras.get(reserva.idempreendimento);

            const comparacao = await lerComparacao(c.idreserva);
            if (comparacao.jaAprovada) { resumo.ja_aprovadas++; continue; }
            if (!comparacao.temForm) {
                await registrar(reserva, 'ignorada', ['a tela de comparação do CV não mostrou o formulário de aprovação']);
                continue;
            }

            // Séries da condição pela v1 (idserie, quantidade e valor de cada
            // linha). A v3 marca todas as linhas como `ativo: false`, então não
            // dá para confiar nela para saber o que vale.
            const condicoes = (viva.condicoes?.series || []).map((s) => ({
                idserie: Number(s.idserie),
                nome: s.serie || null,
                quantidade: Number(s.quantidade || 0),
                valor: Number(s.valor || 0),
                subtotal: Number(s.valor || 0) * Number(s.quantidade || 0),
            }));
            // Valores da tela de comparação (o que o aprovador vê); a v1 é reserva.
            if (!comparacao.vgvProposta) comparacao.vgvProposta = Number(viva.condicoes?.valor_contrato || 0) || null;
            if (!comparacao.vgvTabela) comparacao.vgvTabela = Number(viva.condicoes?.vgv_tabela || 0) || null;
            const rendaApi = Number(viva.titular?.renda_familiar || 0) || null;

            const r = avaliar({ regraEmp, comparacao, condicoes, rendaApi, cfg });
            if (!r.ok) {
                resumo.fora_da_regra++;
                await registrar(reserva, 'fora_da_regra', r.motivos, r.detalhes);
                continue;
            }

            if (modo !== 'aprovar') {
                resumo.simuladas++;
                await registrar(reserva, 'simulada', [], r.detalhes);
                continue;
            }

            const envio = await aprovarNoPainel(c.idreserva, comparacao, cfg.comentario);
            const depois = await reservaAoVivo(c.idreserva);
            if (String(depois?.condicao_aprovada || '').toUpperCase() === 'S') {
                resumo.aprovadas++;
                await registrar(reserva, 'aprovada', [], { ...r.detalhes, http: envio.status });
                console.log(`[CV robô] reserva ${c.idreserva} aprovada (dentro da regra).`);
            } else {
                resumo.erros++;
                await registrar(reserva, 'erro', [`o CV não confirmou a aprovação (HTTP ${envio.status})`], r.detalhes);
            }
        } catch (err) {
            resumo.erros++;
            const msg = String(err?.message || err).slice(0, 300);
            await registrar({ ...c }, 'erro', [msg]).catch(() => {});
            // Sessão caiu: não adianta seguir a fila.
            if (/sess[ãa]o do rob[ôo]|n[ãa]o tem sess[ãa]o/i.test(msg)) break;
        }
    }

    return { modo, ...resumo };
}

export default { rodar, avaliar, lerConfig, salvarConfig, historico, numeroBR };

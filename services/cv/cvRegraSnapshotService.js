// services/cv/cvRegraSnapshotService.js
//
// Foto da regra de reservas de cada empreendimento, lida no painel do CV.
//
// A regra mora no CV (Reservas e Simulações > Regras e > Séries) e só se lê
// pelo painel, com a sessão do robô. Quem lê é o cvReaprovacaoService; a cada
// leitura ele grava aqui. A ficha comercial mostra esta foto, com a data da
// leitura, para não depender da sessão estar viva na hora em que alguém abre
// a ficha. O CV continua mandando: a foto nunca é editada pelo Office.

import crypto from 'crypto';
import db from '../../models/sequelize/index.js';
import { ensureCvRoboSchema } from '../../lib/ensureCvRoboSchema.js';

const SEM_TETO = 999999.99;      // como "sem máximo" é gravado na aba Séries
const VOLATEIS = /token|csrf|hash|^acao$|^ajax/i;

const numero = (txt) => {
    if (txt == null) return null;
    if (typeof txt === 'number') return Number.isFinite(txt) ? txt : null;
    const s = String(txt).replace(/[^\d,.-]/g, '');
    if (!s) return null;
    const n = Number(s.replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
};

function estavel({ automatica, regra, series, bloqueioSeries }) {
    const r = Object.fromEntries(Object.entries(regra || {}).filter(([k]) => !VOLATEIS.test(k)).sort(([a], [b]) => a.localeCompare(b)));
    return { automatica: !!automatica, regra: r, series: series || {}, bloqueioSeries: bloqueioSeries ?? null };
}

/** Grava a leitura. Só marca `mudou_em` quando o conteúdo mudou de verdade. */
export async function salvarSnapshotRegra(idempreendimento, leitura) {
    const id = Number(idempreendimento);
    if (!Number.isInteger(id) || id <= 0 || !leitura) return;
    await ensureCvRoboSchema();
    const conteudo = estavel(leitura);
    const hash = crypto.createHash('sha1').update(JSON.stringify(conteudo)).digest('hex');
    const [[atual]] = await db.sequelize.query(
        'SELECT content_hash, automatica, regra, series, lido_em FROM cv_regra_reservas_snapshot WHERE idempreendimento = :id',
        { replacements: { id } },
    );
    if (atual && atual.content_hash === hash) {
        await db.sequelize.query('UPDATE cv_regra_reservas_snapshot SET lido_em = NOW() WHERE idempreendimento = :id', { replacements: { id } });
        return;
    }
    const regraJson = JSON.stringify({ ...conteudo.regra, __bloqueio_series: conteudo.bloqueioSeries });
    await db.sequelize.query(`
        INSERT INTO cv_regra_reservas_snapshot (idempreendimento, automatica, regra, series, content_hash, lido_em, mudou_em, anterior)
        VALUES (:id, :automatica, CAST(:regra AS jsonb), CAST(:series AS jsonb), :hash, NOW(), :mudou, CAST(:anterior AS jsonb))
        ON CONFLICT (idempreendimento) DO UPDATE SET
            automatica = EXCLUDED.automatica, regra = EXCLUDED.regra, series = EXCLUDED.series,
            content_hash = EXCLUDED.content_hash, lido_em = EXCLUDED.lido_em,
            mudou_em = EXCLUDED.mudou_em, anterior = EXCLUDED.anterior
    `, {
        replacements: {
            id,
            automatica: conteudo.automatica,
            regra: regraJson,
            series: JSON.stringify(conteudo.series),
            hash,
            mudou: atual ? new Date() : null,
            anterior: atual ? JSON.stringify({ automatica: atual.automatica, regra: atual.regra, series: atual.series, lido_em: atual.lido_em }) : null,
        },
    });
}

export async function lerSnapshotRegra(idempreendimento) {
    await ensureCvRoboSchema();
    const [[row]] = await db.sequelize.query(
        'SELECT * FROM cv_regra_reservas_snapshot WHERE idempreendimento = :id',
        { replacements: { id: Number(idempreendimento) } },
    );
    return row || null;
}

/** Empreendimentos com ficha em aberto cuja foto da regra está velha (ou não existe). */
export async function empreendimentosComRegraVencida({ horas = 20, limite = 2 } = {}) {
    await ensureCvRoboSchema();
    const [rows] = await db.sequelize.query(`
        SELECT DISTINCT c.idempreendimento, s.lido_em
          FROM enterprise_conditions c
          LEFT JOIN cv_regra_reservas_snapshot s ON s.idempreendimento = c.idempreendimento
         WHERE c.idempreendimento IS NOT NULL
           AND c.status <> 'closed'
           AND c.reference_month >= date_trunc('month', NOW() - INTERVAL '1 month')
           AND (s.lido_em IS NULL OR s.lido_em < NOW() - make_interval(hours => :horas))
         ORDER BY s.lido_em NULLS FIRST
         LIMIT :limite
    `, { replacements: { horas, limite } });
    return rows.map((r) => Number(r.idempreendimento));
}

// ── Leitura para a ficha ─────────────────────────────────────────────────────

function serieParaFicha(id, s) {
    const max = numero(s.valor_max);
    const linhas = numero(s.linhas_max);
    const parcMax = numero(s.parcelas_max);
    const parcMin = numero(s.parcelas_min);
    return {
        idserie: Number(id),
        nome: s.nome || `Série ${id}`,
        valor_min: numero(s.valor_min) || null,
        // 999.999,99 é "sem teto"; 0,00 é teto zero (série travada), e o CV
        // lê assim mesmo. A ficha mostra o que o CV cobra.
        valor_max: max == null ? null : (max >= SEM_TETO ? null : max),
        travada: max === 0,
        parcelas_min: parcMin || null,
        parcelas_max: parcMax || null,          // 0 = sem limite
        linhas_max: linhas || null,             // 0 = sem limite
        renda_pct: numero(s.renda_pct) || null,
        bloqueia_minimo: s.bloqueia_minimo === true || s.bloqueia_minimo === 'S',
    };
}

/**
 * A regra como a ficha mostra: o que o CV cobra de cada série e o limite do
 * pró-soluto. `null` quando o empreendimento nunca teve a regra lida.
 */
export function regraParaFicha(row) {
    if (!row) return null;
    const regra = row.regra || {};
    const series = Object.entries(row.series || {})
        .map(([id, s]) => serieParaFicha(id, s))
        .sort((a, b) => a.idserie - b.idserie);
    const forma = String(regra.simulacao_forma_alertar || '').toUpperCase();
    const vale = String(regra.funcionalidades_regras || '');
    return {
        lido_em: row.lido_em,
        mudou_em: row.mudou_em,
        tem_regra: Object.keys(regra).length > 1 || series.length > 0,
        vale_para: { S: 'simulação', R: 'reserva', A: 'simulação e reserva' }[vale] || null,
        modo: forma === 'B' ? 'bloquear' : (forma === 'A' ? 'alertar' : null),
        series_so_da_lista: regra.__bloqueio_series === 'S' || regra.__bloqueio_series === true,
        pro_soluto_max_pct: numero(regra.simulacao_percentual_total_prosoluto) || null,
        pro_soluto_limite_valor: numero(regra.simulacao_valor_total_prosoluto) || null,
        series,
    };
}

export default { salvarSnapshotRegra, lerSnapshotRegra, empreendimentosComRegraVencida, regraParaFicha };

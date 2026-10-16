// services/comercial/fichaEfetiva.js
//
// A regra de negociação EFETIVA de um empreendimento para quem lê a ficha por
// fora da tela (relatório de recurso próprio, Eme, Eme Atende).
//
// O CV manda: ato mínimo, parcela mínima, número de parcelas, % da renda e o
// limite do pró-soluto vêm da foto da regra de reservas lida no painel do CV
// (cv_regra_reservas_snapshot). Os campos antigos da ficha (act_installment_value,
// rp_installment_value, max_installments, max_entry_value, rp_rule) só valem
// quando o CV não tem o dado: a tela nova não os pede mais.

import { lerSnapshotRegra, regraParaFicha } from '../cv/cvRegraSnapshotService.js';

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const ehAto = (s) => /\bato\b|a vista|sinal/.test(semAcento(s.nome));
const ehParcelado = (s) => /parcelad|mensa/.test(semAcento(s.nome));

/** Regra da ficha (regraParaFicha) → números que os relatórios comparam. */
export function regraCvParaConferencia(regra) {
    if (!regra?.tem_regra) return null;
    const series = (regra.series || []).filter((s) => !s.travada);
    const ato = series.find(ehAto);
    const parc = series.find(ehParcelado);
    const out = {
        atoMinimo: ato?.valor_min ?? null,
        parcelaMinima: parc?.valor_min ?? null,
        maxParcelas: parc?.parcelas_max ?? null,
        limiteRendaPct: parc?.renda_pct ?? null,
        proSolutoPct: regra.pro_soluto_max_pct ?? null,
        proSolutoLimite: regra.pro_soluto_limite_valor ?? null,
        lidoEm: regra.lido_em ?? null,
    };
    return Object.values(out).some((v) => v != null) ? out : null;
}

const cache = new Map();
const CACHE_MS = 5 * 60 * 1000;

/** Regra do CV do empreendimento, pronta para conferir (null sem foto). */
export async function regraCvDoEmpreendimento(idempreendimento) {
    const id = Number(idempreendimento);
    if (!id) return null;
    const hit = cache.get(id);
    if (hit && Date.now() - hit.em < CACHE_MS) return hit.v;
    const v = regraCvParaConferencia(regraParaFicha(await lerSnapshotRegra(id)));
    cache.set(id, { em: Date.now(), v });
    return v;
}

/**
 * Campos de negociação com os nomes antigos, já com o CV por cima. Para quem
 * ainda lê o módulo pelos nomes de coluna (Eme, Eme Atende).
 */
export function negociacaoEfetiva(modulo = {}, cv = null) {
    const n = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
    return {
        act_installment_value: cv?.atoMinimo ?? n(modulo.act_installment_value),
        rp_installment_value: cv?.parcelaMinima ?? n(modulo.rp_installment_value),
        max_installments: cv?.maxParcelas ?? n(modulo.max_installments),
        max_entry_value: cv?.proSolutoPct ?? n(modulo.max_entry_value),
        limite_renda_pct: cv?.limiteRendaPct ?? null,
        limite_parcelado_valor: cv?.proSolutoLimite ?? null,
        fonte_negociacao: cv ? 'regra de reservas do CV' : 'ficha comercial',
    };
}

export default { regraCvDoEmpreendimento, regraCvParaConferencia, negociacaoEfetiva };

// services/deptSpending/deptSpendingInsightService.js
//
// "Leitura para decisão" do Relatório Gerencial de Investimento: até 3 blocos
// narrativos gerados por IA (Gemini Flash via generateJson) a partir dos números
// JÁ COMPUTADOS pelo motor + regras de análise fixas. A IA nunca inventa número —
// o prompt fornece tudo pronto e formatado.
//
// Cache: report_insights do EMPREENDIMENTO (viability_stage_settings) ou, no
// relatório legado da SPE inteira, da empresa (viability_enterprise_settings) =
//   { month, hash, generatedAt, source: 'ai'|'fallback', blocks: [{title, tone, text}] }
// Regenera quando o mês de referência ou os números mudam (hash), ou quando o
// admin força pelo endpoint de regeneração. Sem chave Gemini / falha → fallback
// determinístico por template (a seção nunca quebra).

import crypto from 'crypto';
import { generateJson, hasGeminiKey } from '../OfficeAI/geminiClient.js';
import { getReportInsightsCache, setReportInsightsCache } from './deptSpendingConfigService.js';

const TONES = new Set(['ok', 'atencao', 'risco']);

const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const pct = (v) => `${(Number(v || 0) * 100).toFixed(1)}%`;

/* Hash estável dos números que sustentam a narrativa (muda número → regenera). */
export function buildReportHash(report) {
    const b = report?.kpis?.buckets || {};
    const pick = (x) => [x?.teto, x?.consumido, x?.realizadoAno, x?.projetadoAno].map((n) => Math.round(Number(n || 0)));
    const base = {
        m: report?.refMonth,
        mkt: pick(b.marketing),
        loja: pick(b.loja),
        tot: pick(b.total),
        vgv: [report?.kpis?.vgv?.yearVgv, report?.kpis?.vgv?.nextYearsVgv, report?.viability?.futureUnits]
            .map((n) => Math.round(Number(n || 0))),
    };
    return crypto.createHash('sha1').update(JSON.stringify(base)).digest('hex').slice(0, 16);
}

/* Fallback determinístico: 3 blocos por template, sem IA. Sem em-dash (regra do projeto). */
function fallbackBlocks(report) {
    const { buckets } = report.kpis;
    const ritmo = report.governance.ritmoLinear;
    const toneOf = (s) => (s === 'acima' ? 'risco' : s === 'atencao' ? 'atencao' : 'ok');

    const mkt = buckets.marketing;
    const loja = buckets.loja;
    const blocks = [
        {
            title: mkt.status === 'dentro' ? 'Marketing sob controle' : mkt.status === 'atencao' ? 'Marketing acima do ritmo' : 'Marketing estourado',
            tone: toneOf(mkt.status),
            text: `Já foi pago ${pct(mkt.pctConsumido)} do teto aprovado (${brl(mkt.consumido)} de ${brl(mkt.teto)}), contra um ritmo linear esperado de ${pct(ritmo)}. Somando a projeção futura, o plano do ano chega a ${brl(mkt.planoAno)}. Saldo de ${brl(mkt.saldo)}.`,
        },
    ];
    if (loja.teto > 0 || loja.consumido > 0) {
        blocks.push({
            title: loja.excedenteVida > 0 ? 'Loja no teto' : loja.status === 'dentro' ? 'Loja dentro do previsto' : 'Loja acima do ritmo',
            tone: toneOf(loja.status),
            text: loja.excedenteVida > 0
                ? `A loja atingiu o teto de ${brl(loja.teto)} (pagou ${brl(loja.pagoTotalVida)}); o excedente de ${brl(loja.excedenteVida)} passou a contar como gasto de MKT.`
                : `A loja já pagou ${pct(loja.pctConsumido)} da verba aprovada (${brl(loja.consumido)} de ${brl(loja.teto)}). Saldo de ${brl(loja.saldo)}.`,
        });
    }
    blocks.push({
        title: 'Investimento e curva de vendas',
        tone: 'ok',
        text: `Restam ${Number(report.viability.futureUnits || 0)} unidades a comercializar (${brl(report.kpis.vgv.nextYearsVgv)} projetados para os anos seguintes). Manter o plano de investimento é o que sustenta a aceleração das vendas projetadas.`,
    });
    return blocks.slice(0, 3);
}

/* Prompt estrito: números prontos + regras de análise; JSON de saída fixo. */
function buildPrompt(report) {
    const { buckets, vgv } = report.kpis;
    const v = report.viability;
    const fmtBucket = (b) => `teto ${brl(b.teto)}, PAGO até o mês ${brl(b.consumido)} (${pct(b.pctConsumido)} do teto), saldo ${brl(b.saldo)}, pago dentro do ano ${brl(b.realizadoAno)}, projetado no restante do ano ${brl(b.projetadoAno)} (projeção NÃO é gasto), status calculado "${b.status}"`;

    return `Você é analista financeiro de uma incorporadora. Escreva a seção "Leitura para decisão" de um relatório gerencial de investimento em marketing de UM empreendimento, para a diretoria.

DADOS (use SOMENTE estes números, já formatados; NÃO invente nem recalcule nada):
- Empreendimento: ${report.company.name} | Exercício ${report.year}, realizado até o mês ${report.monthIndex}/${report.year}.
- Ritmo linear esperado do ano até aqui: ${pct(report.governance.ritmoLinear)}.
- MARKETING (controle do EXERCÍCIO: teto = VGV projetado do ano × %; viabilidade vida útil de referência ${brl(buckets.marketing.tetoVidaUtil)}): ${fmtBucket(buckets.marketing)}${buckets.marketing.lojaExcedenteAno > 0 ? ` (inclui ${brl(buckets.marketing.lojaExcedenteAno)} de excedente da loja - regra: o que a loja gasta acima do teto vira gasto de MKT)` : ''}. Plano do ano (pago + projetado): ${brl(buckets.marketing.planoAno)}.
- LOJA FÍSICA: ${fmtBucket(buckets.loja)}${buckets.loja.excedenteVida > 0 ? ` (pagou no total ${brl(buckets.loja.pagoTotalVida)}; o excedente de ${brl(buckets.loja.excedenteVida)} foi transferido ao MKT)` : ''}.
- TOTAL APROVADO: ${fmtBucket(buckets.total)}.
- VGV projetado no exercício: ${brl(vgv.yearVgv)} (${vgv.yearUnits} unidades de ${vgv.totalUnits}). VGV projetado para os anos seguintes: ${brl(vgv.nextYearsVgv)}.
- Unidades vendidas de fato até o mês: ${v.soldUnitsRealYtd}. Unidades a comercializar: ${v.futureUnits} (fonte: ${v.futureUnitsSource === 'projecao' ? 'projeção de vendas' : v.futureUnitsSource === 'estoque' ? 'estoque disponível' : 'nenhuma'}).

NOTA: o "projetado no restante do ano" é o saldo do exercício dividido igualmente pelos meses restantes (não segue a curva de vendas); valor negativo significa que o teto do exercício já foi ultrapassado.

REGRAS DE ANÁLISE (siga nesta ordem):
1. Compare o % consumido de cada verba com o ritmo linear do ano: abaixo = sob controle; acima = atenção; acima de 100% = estouro.
2. Avalie se o saldo de marketing sustenta as vendas que ainda vão acontecer (unidades a comercializar / VGV futuro).
3. Para a loja, comente a verba comprometida versus o saldo restante.

FORMATO DA RESPOSTA (JSON puro):
{"blocks":[{"title":"...","tone":"ok|atencao|risco","text":"..."}]}
- Exatamente 3 blocos, um por regra acima.
- "title": até 5 palavras, direto (ex.: "MKT sob controle").
- "text": 1 parágrafo de no máximo 45 palavras, tom executivo, citando os números fornecidos.
- "tone": "ok" quando dentro, "atencao" quando acima do ritmo, "risco" quando estourado ou saldo insuficiente.
- Escreva em português do Brasil. PROIBIDO usar travessão (em-dash); use hífen "-" quando precisar.`;
}

function sanitizeBlocks(raw) {
    const list = Array.isArray(raw?.blocks) ? raw.blocks : Array.isArray(raw) ? raw : null;
    if (!list) return null;
    const blocks = list
        .map((b) => ({
            title: String(b?.title || '').replace(/—/g, '-').trim().slice(0, 60),
            tone: TONES.has(b?.tone) ? b.tone : 'ok',
            text: String(b?.text || '').replace(/—/g, '-').trim().slice(0, 400),
        }))
        .filter((b) => b.title && b.text)
        .slice(0, 3);
    return blocks.length ? blocks : null;
}

/**
 * Devolve os insights do relatório (cache → IA → fallback). `force` ignora o cache.
 */
export async function getReportInsights({ enterpriseKey = null, companyId = null, report, force = false }) {
    const hash = buildReportHash(report);
    const month = report.refMonth;
    const cacheKey = {
        enterpriseKey: enterpriseKey ?? report?.company?.enterpriseKey ?? null,
        companyId: companyId ?? report?.company?.companyId ?? null,
    };

    if (!force) {
        const cached = await getReportInsightsCache(cacheKey);
        if (cached?.month === month && cached?.hash === hash && Array.isArray(cached?.blocks) && cached.blocks.length) {
            return cached;
        }
    }

    let blocks = null;
    let source = 'fallback';
    if (hasGeminiKey()) {
        try {
            const raw = await generateJson(buildPrompt(report), { maxOutputTokens: 1024 });
            blocks = sanitizeBlocks(raw);
            if (blocks) source = 'ai';
        } catch (e) {
            console.warn('[DeptSpendingInsights] IA falhou, usando fallback:', e?.message);
        }
    }
    if (!blocks) blocks = fallbackBlocks(report);

    const insights = { month, hash, generatedAt: new Date().toISOString(), source, blocks };
    try {
        await setReportInsightsCache(cacheKey, insights);
    } catch (e) {
        console.warn('[DeptSpendingInsights] falha ao salvar cache:', e?.message);
    }
    return insights;
}

export default { getReportInsights, buildReportHash };

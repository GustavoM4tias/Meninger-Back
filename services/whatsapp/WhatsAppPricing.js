// services/whatsapp/WhatsAppPricing.js
//
// Tarifas da Cloud API para ESTIMATIVA de gasto (Brasil). A cobrança real é a
// da fatura da Meta — aqui é aproximação para o painel de controle interno.
//
// Modelo PMP (Pay-Per-Message, vigente desde jul/2025): cobra-se por MENSAGEM
// de template entregue, por categoria. Mensagens de SERVIÇO (respostas/mídia
// dentro da janela de 24h) são GRATUITAS. A Meta sinaliza no webhook via
// pricing.billable=false — quando temos esse dado, ele manda; sem ele, caímos
// na heurística por categoria.
//
// Valores default em USD (tabela Brasil, faixa inicial). Convertidos a BRL pela
// taxa configurável. Ajuste por env sem deploy de código:
//   WA_RATE_MARKETING_USD, WA_RATE_UTILITY_USD, WA_RATE_AUTH_USD, WA_USD_BRL

const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : d;
};

// USD por mensagem entregue, por categoria (Brasil, referência 2025/2026).
export function getRatesUSD() {
    return {
        marketing:      num(process.env.WA_RATE_MARKETING_USD, 0.0625),
        utility:        num(process.env.WA_RATE_UTILITY_USD, 0.0068),
        authentication: num(process.env.WA_RATE_AUTH_USD, 0.0068),
        service:        0, // serviço é sempre gratuito
    };
}

export function getUsdToBrl() {
    return num(process.env.WA_USD_BRL, 5.5);
}

/**
 * Custo estimado (BRL) de UMA mensagem.
 * @param {{cost_category?:string, billable?:boolean, status?:string}} m
 * @returns {number}
 */
export function estimateCostBRL(m) {
    // Só mensagem efetivamente enviada/entregue/lida gera custo.
    if (m?.status && !['sent', 'delivered', 'read'].includes(m.status)) return 0;
    // Sinal explícito da Meta manda: billable=false = gratuita.
    if (m?.billable === false) return 0;
    const cat = String(m?.cost_category || '').toLowerCase();
    if (cat === 'service') return 0;
    const rates = getRatesUSD();
    // Categoria conhecida → tarifa dela. Sem categoria ainda (status pendente do
    // webhook) → não estima (evita inflar o total com msgs que podem ser grátis).
    const usd = rates[cat];
    if (usd === undefined) return 0;
    return usd * getUsdToBrl();
}

export default { getRatesUSD, getUsdToBrl, estimateCostBRL };

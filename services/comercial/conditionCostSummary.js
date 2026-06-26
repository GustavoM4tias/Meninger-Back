// services/comercial/conditionCostSummary.js
//
// Fonte ÚNICA de custo por pagador (Menin / Cliente) no backend.
// Espelha Meninger-Front/src/views/Office/Comercial/Conditions/components/costSummary.js,
// mas usa o modelo de PAGADOR UNIFORME (itbi_paid_by, cca_paid_by, digital_cert_paid_by)
// com fallback para os campos legados, para funcionar antes e depois do backfill.
//
// É a base dos relatórios de custo (Menin x cliente) e da integração com a Eme:
// nunca leia custo da camada de view; consuma este módulo.
//
// Regras (mesmas do front, agora com pagador configurável por item):
//  - CCA: pago_por = cca_paid_by, ou (legado) 'menin' quando cca_charges_company.
//  - Certificação Digital: digital_cert_paid_by, ou (legado) 'menin' quando tem custo.
//  - Pacote CEF: cef_package_paid_by ('menin' | 'client').
//  - ITBI: itbi_paid_by (default 'client'), e só conta quando NÃO isento.
//  - Cartório (prenotação + registro): cartorio_paid_by ('menin' | 'client').

const num = (v) => (v == null || v === '' ? 0 : Number(v) || 0);

// Pagador de cada item: campo novo (uniforme) com fallback ao legado.
export function ccaPayer(mod)  { return mod.cca_paid_by || (mod.cca_charges_company ? 'menin' : null); }
export function certPayer(mod) { return mod.digital_cert_paid_by || (mod.digital_cert_has_cost ? 'menin' : null); }
export function itbiPayer(mod) { return mod.itbi_paid_by || 'client'; }

// Resumo de custo de UM módulo: { menin[], client[], totalMenin, totalClient }.
export function computeModuleCostSummary(mod = {}) {
    const menin = [];
    const client = [];
    const add = (payer, label, value) => {
        if (value <= 0) return;
        if (payer === 'menin') menin.push({ label, value });
        else if (payer === 'client') client.push({ label, value });
    };

    add(ccaPayer(mod),  'CCA', num(mod.cca_cost));
    add(certPayer(mod), 'Certificação Digital', num(mod.digital_cert_cost));
    add(mod.cef_package_paid_by, 'Pacote CEF', num(mod.cef_package_avg_value));
    if (!mod.itbi_exempt) add(itbiPayer(mod), 'ITBI', num(mod.itbi_avg_value));
    if (mod.cartorio_paid_by) {
        add(mod.cartorio_paid_by, 'Cartório - Prenotação', num(mod.cartorio_prenotacao_value));
        add(mod.cartorio_paid_by, 'Cartório - Registro',   num(mod.cartorio_registration_value));
    }

    const totalMenin  = menin.reduce((s, i) => s + i.value, 0);
    const totalClient = client.reduce((s, i) => s + i.value, 0);
    return { menin, client, totalMenin, totalClient };
}

// Agrega vários módulos (ex.: todos os módulos de uma ficha), somando por rótulo
// dentro de cada pagador. Base do resumo da ficha e dos relatórios consolidados.
export function aggregateCostSummaries(modules = []) {
    const meninMap = new Map();
    const clientMap = new Map();
    const accumulate = (map, items) => {
        for (const it of items) map.set(it.label, (map.get(it.label) || 0) + it.value);
    };

    for (const mod of modules) {
        const s = computeModuleCostSummary(mod);
        accumulate(meninMap, s.menin);
        accumulate(clientMap, s.client);
    }

    const toList = (map) => [...map.entries()].map(([label, value]) => ({ label, value }));
    const menin = toList(meninMap);
    const client = toList(clientMap);
    return {
        menin,
        client,
        totalMenin:  menin.reduce((s, i) => s + i.value, 0),
        totalClient: client.reduce((s, i) => s + i.value, 0),
    };
}

export default { computeModuleCostSummary, aggregateCostSummaries, ccaPayer, certPayer, itbiPayer };

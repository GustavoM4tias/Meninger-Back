// services/marketing/metaLeadExtract.js
//
// Extrator ÚNICO da contagem de leads a partir de actions[] dos insights da
// Meta. Usado pelo sync de campanhas, pela série diária e pelo breakdown
// diário do modal — antes cada um tinha sua própria lista de action_types,
// o que gerava números diferentes entre telas.
//
// Semântica dos action_types:
//   lead                              → TOTAL de leads da campanha (form + pixel)
//   onsite_conversion.lead_grouped    → leads de formulário Meta (on-Facebook)
//   leadgen.other                     → idem (variante antiga de instant forms)
//   offsite_conversion.fb_pixel_lead  → leads de PIXEL (conversão no site/LP —
//                                       NUNCA chegam pelo webhook de Lead Ads)
//
// form = total - pixel (mantém form + pixel = total mesmo quando a Meta
// reporta offsites extras dentro de 'lead').

const TOTAL_TYPE   = 'lead';
const ONSITE_TYPES = ['onsite_conversion.lead_grouped', 'leadgen.other'];
const PIXEL_TYPE   = 'offsite_conversion.fb_pixel_lead';

/**
 * @param {Array|undefined} actions — insights.actions[] da Graph API
 * @returns {{ total: number, form: number, pixel: number }}
 */
export function extractLeadBreakdown(actions) {
    if (!Array.isArray(actions)) return { total: 0, form: 0, pixel: 0 };

    const val = (type) => {
        const a = actions.find(x => x.action_type === type);
        return a ? (Number(a.value) || 0) : 0;
    };

    const pixel = val(PIXEL_TYPE);

    let onsite = 0;
    for (const t of ONSITE_TYPES) {
        const v = val(t);
        if (v > 0) { onsite = v; break; }
    }

    // 'lead' é o total oficial da Meta; se ausente, soma os componentes.
    let total = val(TOTAL_TYPE);
    if (!(total > 0)) total = onsite + pixel;

    const form = Math.max(0, total - pixel);
    return { total, form, pixel };
}

export default { extractLeadBreakdown };

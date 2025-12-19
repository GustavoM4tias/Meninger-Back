// src/services/cv/enterpriseUnitsSummaryService.js
import db from '../../models/sequelize/index.js';

const { CvEnterpriseStage, CvEnterpriseBlock, CvEnterpriseUnit } = db;

const norm = (s) =>
    String(s || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();

/**
 * Classifica unidade em vendido / reservado / bloqueado / disponível
 * Regras:
 *  - mapa disponibilidade numérico (1..5)
 *  - fallback textual (vend/reserv/bloq/disp)
 *  - data_bloqueio força bloqueado
 */
export function classifyUnitStatus(unit) {
    const raw = unit?.situacao_mapa_disponibilidade;
    const numeric = Number(raw);
    const statusNum = !Number.isNaN(numeric) && numeric > 0 ? numeric : null;

    let isSold = false;
    let isReserved = false;
    let isBlocked = false;

    if (statusNum !== null) {
        isSold = statusNum === 3;
        isReserved = statusNum === 2 || statusNum === 5;
        isBlocked = statusNum === 4;
    } else {
        const s = norm(raw);
        if (s.includes('vend')) isSold = true;
        if (s.includes('reserv')) isReserved = true;
        if (s.includes('bloq')) isBlocked = true;
    }

    // regra extra: data_bloqueio força BLOQUEADO
    if (unit?.data_bloqueio) {
        isBlocked = true;
        isSold = false;
        isReserved = false;
    }

    return { isSold, isReserved, isBlocked };
}

/**
 * Resumo de unidades do CV (snapshot atual) por empreendimento
 * Retorna:
 *  - totalUnits
 *  - soldUnitsStock
 *  - reservedUnits
 *  - blockedUnits
 *  - availableUnits
 *  - availableInventory (não vendidas = disp + reserv + bloqueadas)
 */
export async function summarizeUnitsFromDb(cvEnterpriseId) {
    const empty = {
        totalUnits: 0,
        soldUnitsStock: 0,
        reservedUnits: 0,
        blockedUnits: 0,
        availableUnits: 0,
        availableInventory: 0
    };

    const id = Number(cvEnterpriseId);
    if (!id) return empty;

    const stages = await CvEnterpriseStage.findAll({
        where: { idempreendimento: id },
        attributes: ['idetapa']
    });

    const stageIds = stages.map((s) => s.idetapa);
    if (!stageIds.length) return empty;

    const blocks = await CvEnterpriseBlock.findAll({
        where: { idetapa: stageIds },
        attributes: ['idbloco']
    });

    const blockIds = blocks.map((b) => b.idbloco);
    if (!blockIds.length) return empty;

    const units = await CvEnterpriseUnit.findAll({
        where: { idbloco: blockIds },
        attributes: ['idunidade', 'situacao_mapa_disponibilidade', 'data_bloqueio']
    });

    let totalUnits = 0;
    let soldUnitsStock = 0;
    let reservedUnits = 0;
    let blockedUnits = 0;
    let availableUnits = 0;

    for (const u of units) {
        totalUnits += 1;
        const st = classifyUnitStatus(u);

        if (st.isSold) soldUnitsStock += 1;
        else if (st.isReserved) reservedUnits += 1;
        else if (st.isBlocked) blockedUnits += 1;
        else availableUnits += 1;
    }

    const availableInventory = availableUnits + reservedUnits + blockedUnits;

    return {
        totalUnits,
        soldUnitsStock,
        reservedUnits,
        blockedUnits,
        availableUnits,
        availableInventory
    };
}

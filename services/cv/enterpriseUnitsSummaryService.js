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

    if (unit?.data_bloqueio) {
        isBlocked = true;
        isSold = false;
        isReserved = false;
    }

    return { isSold, isReserved, isBlocked };
}

// ─── helper interno ──────────────────────────────────────────────────────────
function zeroSummary() {
    return {
        totalUnits: 0,
        soldUnits: 0,
        soldUnitsStock: 0,
        reservedUnits: 0,
        blockedUnits: 0,
        availableUnits: 0,
        availableInventory: 0,
    };
}

function countUnits(units) {
    let totalUnits = 0, soldUnitsStock = 0, reservedUnits = 0, blockedUnits = 0, availableUnits = 0;

    for (const u of units) {
        totalUnits++;
        const st = classifyUnitStatus(u);
        if (st.isSold) soldUnitsStock++;
        else if (st.isReserved) reservedUnits++;
        else if (st.isBlocked) blockedUnits++;
        else availableUnits++;
    }

    const availableInventory = availableUnits + reservedUnits + blockedUnits;

    return {
        totalUnits,
        soldUnits: soldUnitsStock,
        soldUnitsStock,
        reservedUnits,
        blockedUnits,
        availableUnits,
        availableInventory,
    };
}
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CC MÓDULO — resumo de unidades de uma etapa específica via idetapa_int (CC Sienge).
 *
 * Retorna null quando a etapa não é encontrada (sinal ao caller para tentar outro caminho).
 * Retorna objeto com cvEnterpriseId incluído para correlação com o empreendimento pai.
 */
export async function summarizeUnitsFromStageInt(idetapa_int) {
    if (!idetapa_int) return null;

    // idetapa_int é character varying no PostgreSQL
    const stage = await CvEnterpriseStage.findOne({
        where: { idetapa_int: String(idetapa_int) },
        attributes: ['idetapa', 'idempreendimento']
    });

    if (!stage) return null;

    const cvEnterpriseId = stage.idempreendimento ? Number(stage.idempreendimento) : null;

    const blocks = await CvEnterpriseBlock.findAll({
        where: { idetapa: stage.idetapa },
        attributes: ['idbloco']
    });

    const blockIds = blocks.map((b) => b.idbloco);
    if (!blockIds.length) return { ...zeroSummary(), cvEnterpriseId };

    const units = await CvEnterpriseUnit.findAll({
        where: { idbloco: blockIds },
        attributes: ['idunidade', 'situacao_mapa_disponibilidade', 'data_bloqueio']
    });

    return { ...countUnits(units), cvEnterpriseId };
}

/**
 * CC MESTRE — resumo de unidades do CC que possui registro em enterprise_cities.
 *
 * Problema: a etapa do mestre no CV (ex: idetapa=43 / CC 99901) agrega TODAS as
 * unidades do empreendimento (727), inclusive as dos módulos filhos (99903, 99905).
 * Se usarmos a etapa diretamente, sempre obteríamos o total errado.
 *
 * Solução: em uma única passagem sobre todas as unidades do empreendimento,
 * separamos as que pertencem a etapas de MÓDULO (idetapa_int != masterErpId e != null)
 * das que pertencem ao MESTRE.
 *
 *   Master = Total empresa − Σ módulos
 *
 * Isso funciona em qualquer contexto (request isolado ou em batch) porque a
 * resolução é autossuficiente — não depende de irmãos na mesma requisição.
 */
export async function summarizeMasterCcFromDb(cvEnterpriseId, masterErpId) {
    const id = Number(cvEnterpriseId);
    if (!id) return zeroSummary();

    const masterStr = String(masterErpId);

    // Todas as etapas do empreendimento
    const allStages = await CvEnterpriseStage.findAll({
        where: { idempreendimento: id },
        attributes: ['idetapa', 'idetapa_int']
    });

    if (!allStages.length) return zeroSummary();

    const allStageIds = allStages.map((s) => s.idetapa);

    // Etapas que são MÓDULOS: têm idetapa_int definido e diferente do mestre
    const moduleStageIds = new Set(
        allStages
            .filter((s) => s.idetapa_int && s.idetapa_int !== masterStr)
            .map((s) => s.idetapa)
    );

    // Todos os blocos (mapeando idbloco → idetapa para saber a qual etapa pertencem)
    const allBlocks = await CvEnterpriseBlock.findAll({
        where: { idetapa: allStageIds },
        attributes: ['idbloco', 'idetapa']
    });

    const blockIds = allBlocks.map((b) => b.idbloco);
    if (!blockIds.length) return zeroSummary();

    const blockToStage = new Map(allBlocks.map((b) => [b.idbloco, b.idetapa]));

    // Todas as unidades do empreendimento em uma única query
    const units = await CvEnterpriseUnit.findAll({
        where: { idbloco: blockIds },
        attributes: ['idunidade', 'idbloco', 'situacao_mapa_disponibilidade', 'data_bloqueio']
    });

    // Conta separado: empresa inteira e apenas os módulos
    let totAll = 0, soldAll = 0, reservedAll = 0, blockedAll = 0, availableAll = 0;
    let totMod = 0, soldMod = 0, reservedMod = 0, blockedMod = 0, availableMod = 0;

    for (const u of units) {
        const stageId = blockToStage.get(u.idbloco);
        const st = classifyUnitStatus(u);
        const isMod = moduleStageIds.has(stageId);

        totAll++;
        if (st.isSold) { soldAll++; if (isMod) soldMod++; }
        else if (st.isReserved) { reservedAll++; if (isMod) reservedMod++; }
        else if (st.isBlocked) { blockedAll++; if (isMod) blockedMod++; }
        else { availableAll++; if (isMod) availableMod++; }
        if (isMod) totMod++;
    }

    const totalUnits = totAll - totMod;
    const soldUnitsStock = soldAll - soldMod;
    const reservedUnits = reservedAll - reservedMod;
    const blockedUnits = blockedAll - blockedMod;
    const availableUnits = availableAll - availableMod;
    const availableInventory = availableUnits + reservedUnits + blockedUnits;
    return {
        totalUnits,
        soldUnits: soldUnitsStock,
        soldUnitsStock,
        reservedUnits,
        blockedUnits,
        availableUnits,
        availableInventory,
    };
}

/**
 * Resumo de unidades do CV (snapshot atual) por empreendimento completo.
 * Usado como fallback quando não há idetapa_int configurado.
 */
export async function summarizeUnitsFromDb(cvEnterpriseId) {
    const id = Number(cvEnterpriseId);
    if (!id) return zeroSummary();

    const stages = await CvEnterpriseStage.findAll({
        where: { idempreendimento: id },
        attributes: ['idetapa']
    });

    const stageIds = stages.map((s) => s.idetapa);
    if (!stageIds.length) return zeroSummary();

    const blocks = await CvEnterpriseBlock.findAll({
        where: { idetapa: stageIds },
        attributes: ['idbloco']
    });

    const blockIds = blocks.map((b) => b.idbloco);
    if (!blockIds.length) return zeroSummary();

    const units = await CvEnterpriseUnit.findAll({
        where: { idbloco: blockIds },
        attributes: ['idunidade', 'situacao_mapa_disponibilidade', 'data_bloqueio']
    });

    return countUnits(units);
}

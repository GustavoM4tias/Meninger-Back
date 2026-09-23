// scheduler/unitBlockReasonScheduler.js
//
// Mantém em dia o MOTIVO do bloqueio de cada unidade — a matéria-prima do
// estoque comercial bloqueado (services/cv/unitStockService.js).
//
// Sem isto, o Office só sabe que a unidade está bloqueada, e trata igual a que
// a diretoria segurou de propósito (estoque a vender) e a que o ERP travou
// (fora do jogo). Eram 784 unidades no primeiro caso em 22/09/2026 — estoque
// grande demais para ficar invisível.
//
// Ritmo: de hora em hora, no minuto 40, para não cair junto com o sync de
// empreendimentos (que roda de 30 em 30 e recria as unidades). Bloqueio é
// decisão humana no painel; não muda de minuto em minuto.
//
// O trabalho é leitura de TELA do painel do CV (a API não devolve o motivo),
// então cada empreendimento custa algumas requisições. Falha de um não derruba
// os outros; falha de todos estoura, para o job aparecer vermelho na tela.

import UnitBlockReasonSyncService from '../services/bulkData/cv/UnitBlockReasonSyncService.js';

const CRON_EXPR = process.env.UNIT_BLOCK_REASON_CRON_EXPRESSION || '40 * * * *';

export async function run() {
    const svc = new UnitBlockReasonSyncService();
    const r = await svc.syncAll();
    console.log(`[Motivos de bloqueio] ${r.unidades} unidade(s) bloqueada(s) em ${r.empreendimentos} empreendimento(s)`);
    return r;
}

// Primeira leitura logo após o boot: sem ela, um deploy deixaria o estoque
// comercial zerado até a virada da hora, e a diretoria veria disponível a menos.
export default { run, cronPadrao: CRON_EXPR, bootstrapDelayMs: 120_000 };

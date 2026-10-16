// controllers/comercial/conditionFontesController.js
//
// Fontes da ficha comercial: o que a ficha mostra sem ninguém digitar (preço,
// fluxo, regra do CV, estoque, avaliação...). Ver services/comercial/fichaFontesService.js.
//
//   GET  /conditions/:id/modules/:moduleId/fontes            → mês aberto: ao vivo;
//                                                             mês fechado: a foto do mês
//   POST /conditions/:id/modules/:moduleId/fontes/regra       → relê a regra no painel do CV
//
// Acesso igual ao da ficha (getCondition): privilegiado vê qualquer status;
// os demais só autorizada/encerrada e de empreendimento do próprio escopo.

import db from '../../models/sequelize/index.js';
import { visibleCvIds } from '../../services/permissions/accessScopeService.js';
import { montarFontes, limparCacheFontes } from '../../services/comercial/fichaFontesService.js';
import { lerRegraDoEmpreendimento } from '../../services/cv/cvReaprovacaoService.js';
import { cookieAtivo } from '../../lib/cvPainelSessao.js';
import { canEditConditions, isPrivilegedViewer } from './enterpriseConditionController.js';

const { EnterpriseCondition, EnterpriseConditionModule } = db;

const mesAtual = () => {
    const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};

async function carregar(req, res) {
    const condition = await EnterpriseCondition.findByPk(req.params.id);
    if (!condition) { res.status(404).json({ error: 'Ficha não encontrada.' }); return null; }
    const modulo = await EnterpriseConditionModule.findOne({ where: { id: req.params.moduleId, condition_id: condition.id } });
    if (!modulo) { res.status(404).json({ error: 'Módulo não encontrado nesta ficha.' }); return null; }
    if (!(await isPrivilegedViewer(req))) {
        if (!['approved', 'closed'].includes(condition.status)) {
            res.status(403).json({ error: 'Acesso restrito a fichas autorizadas.' }); return null;
        }
        const ids = await visibleCvIds(req.user);
        if (ids !== null && !ids.includes(Number(condition.idempreendimento))) {
            res.status(403).json({ error: 'Você não tem acesso a este empreendimento.' }); return null;
        }
    }
    return { condition, modulo };
}

export const getFontes = async (req, res) => {
    try {
        const ctx = await carregar(req, res);
        if (!ctx) return;
        const { condition, modulo } = ctx;
        if (!condition.idempreendimento) return res.json({ sem_cv: true });

        // Mês que já passou mostra o que valia nele (a foto), se houver.
        const passado = String(condition.reference_month).slice(0, 10) < mesAtual();
        const forcarAoVivo = req.query.live === '1';
        if (modulo.fontes_snapshot && (passado || condition.status === 'approved') && !forcarAoVivo) {
            return res.json({
                ...modulo.fontes_snapshot,
                foto: { em: modulo.fontes_snapshot_at, motivo: modulo.fontes_snapshot_reason },
            });
        }
        const dados = await montarFontes({ idempreendimento: condition.idempreendimento, modulo: modulo.toJSON() });
        if (!dados) return res.status(404).json({ error: 'Empreendimento não encontrado no espelho do CV.' });
        return res.json({ ...dados, foto: null, mes_passado_sem_foto: passado });
    } catch (e) {
        console.error('[conditions] getFontes:', e);
        return res.status(500).json({ error: 'Não foi possível montar os dados do módulo.' });
    }
};

export const refreshRegra = async (req, res) => {
    try {
        if (!(await canEditConditions(req))) return res.status(403).json({ error: 'Você não tem permissão para editar fichas comerciais.' });
        const ctx = await carregar(req, res);
        if (!ctx) return;
        const { condition, modulo } = ctx;
        if (!condition.idempreendimento) return res.status(400).json({ error: 'Ficha sem empreendimento do CV.' });
        if (!(await cookieAtivo())) {
            return res.status(409).json({ error: 'O robô está sem sessão no painel do CV. Conecte uma sessão em CV CRM > Configurações e tente de novo.' });
        }
        await lerRegraDoEmpreendimento(condition.idempreendimento);
        limparCacheFontes();
        const dados = await montarFontes({ idempreendimento: condition.idempreendimento, modulo: modulo.toJSON(), semCache: true });
        return res.json({ ...dados, foto: null });
    } catch (e) {
        console.error('[conditions] refreshRegra:', e);
        return res.status(502).json({ error: `Não foi possível ler a regra no CV: ${e.message}` });
    }
};

/**
 * Congela as fontes de cada módulo da ficha. Chamado ao autorizar e no
 * fechamento do mês. `soSemFoto` não regrava módulo que já tem foto.
 */
export async function congelarFontes(conditionId, motivo, { soSemFoto = false } = {}) {
    const condition = await EnterpriseCondition.findByPk(conditionId);
    if (!condition?.idempreendimento) return { congelados: 0 };
    const modulos = await EnterpriseConditionModule.findAll({ where: { condition_id: condition.id } });
    let congelados = 0;
    for (const m of modulos) {
        if (soSemFoto && m.fontes_snapshot) continue;
        try {
            const dados = await montarFontes({ idempreendimento: condition.idempreendimento, modulo: m.toJSON(), semCache: true });
            if (!dados) continue;
            await m.update({ fontes_snapshot: dados, fontes_snapshot_at: new Date(), fontes_snapshot_reason: motivo });
            congelados++;
        } catch (err) {
            console.warn(`[conditions] foto das fontes do módulo ${m.id} falhou: ${err.message}`);
        }
    }
    return { congelados };
}

export default { getFontes, refreshRegra, congelarFontes };

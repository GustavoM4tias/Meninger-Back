// controllers/comercial/conditionCadastrosController.js
//
// Cadastros únicos da ficha comercial: o que é da cidade, do programa ou da
// empresa, e não do mês. Digitado uma vez aqui, vale para todas as fichas.
//
//   GET    /conditions/cadastros                 → { programas, cidades, prestadores }
//   POST   /conditions/cadastros/:tipo           → cria (tipo: programas | cidades | prestadores)
//   PUT    /conditions/cadastros/:tipo/:id       → altera
//   DELETE /conditions/cadastros/:tipo/:id       → programa e prestador saem da lista
//                                                  (ficam inativos); cidade é apagada
//
// Ler: quem vê fichas. Gravar: quem edita fichas (mesma regra do módulo).

import db from '../../models/sequelize/index.js';
import { canEditConditions } from './enterpriseConditionController.js';

const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];

const texto = (max) => (v) => {
    if (v == null || String(v).trim() === '') return { ok: true, v: null };
    return { ok: true, v: String(v).trim().slice(0, max) };
};
const obrigatorio = (max, rotulo) => (v) => {
    const t = String(v ?? '').trim();
    return t ? { ok: true, v: t.slice(0, max) } : { ok: false, erro: `Informe ${rotulo}.` };
};
const dinheiro = (rotulo) => (v) => {
    if (v == null || v === '') return { ok: true, v: null };
    const n = Number(String(v).replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) && n >= 0 && n < 1e9 ? { ok: true, v: Math.round(n * 100) / 100 } : { ok: false, erro: `${rotulo}: valor inválido.` };
};
const percentual = (rotulo) => (v) => {
    if (v == null || v === '') return { ok: true, v: null };
    const n = Number(String(v).replace(',', '.'));
    return Number.isFinite(n) && n >= 0 && n <= 100 ? { ok: true, v: n } : { ok: false, erro: `${rotulo}: entre 0 e 100.` };
};
const logico = (v) => ({ ok: true, v: v == null || v === '' ? null : Boolean(v) });
const uf = (v) => {
    const t = String(v || '').trim().toUpperCase();
    return UFS.includes(t) ? { ok: true, v: t } : { ok: false, erro: 'Escolha o estado.' };
};
const dataISO = (v) => {
    if (!v) return { ok: true, v: null };
    return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? { ok: true, v: String(v) } : { ok: false, erro: 'Data inválida.' };
};
const tipoPrestador = (v) => (['cca', 'certificadora'].includes(v) ? { ok: true, v } : { ok: false, erro: 'Escolha o tipo: CCA ou certificadora.' });

const TIPOS = {
    programas: {
        tabela: 'comercial_state_programs',
        ordem: 'uf, nome',
        inativa: true,
        campos: {
            uf, nome: obrigatorio(160, 'o nome do programa'), valor: dinheiro('Valor'), valor_especial: dinheiro('Valor especial'),
            publico_especial: texto(200), renda_max: dinheiro('Renda máxima'), regras: texto(4000), vigente_ate: dataISO, ativo: logico,
        },
    },
    cidades: {
        tabela: 'comercial_city_doc_costs',
        ordem: 'uf, cidade',
        inativa: false,
        campos: {
            cidade: obrigatorio(120, 'a cidade'), uf, itbi_isento: logico, itbi_aliquota_pct: percentual('Alíquota do ITBI'),
            itbi_lei: texto(1000), cartorio_prenotacao: dinheiro('Prenotação'), cartorio_registro: dinheiro('Registro'),
            pacote_caixa: dinheiro('Pacote Caixa'), observacao: texto(1000),
        },
    },
    prestadores: {
        tabela: 'comercial_providers',
        ordem: 'tipo, nome',
        inativa: true,
        campos: {
            tipo: tipoPrestador, nome: obrigatorio(160, 'o nome'), contato: texto(160), telefone: texto(40),
            email: texto(160), custo: dinheiro('Custo'), ativo: logico,
        },
    },
};

function validar(tipo, body, parcial) {
    const def = TIPOS[tipo];
    const out = {};
    for (const [campo, fn] of Object.entries(def.campos)) {
        if (parcial && !(campo in body)) continue;
        const r = fn(body[campo]);
        if (!r.ok) return { erro: r.erro };
        if (campo === 'ativo' && r.v == null) continue;
        out[campo] = r.v;
    }
    return { dados: out };
}

export const listCadastros = async (req, res) => {
    try {
        const [programas] = await db.sequelize.query(`SELECT * FROM comercial_state_programs ORDER BY ${TIPOS.programas.ordem}`);
        const [cidades] = await db.sequelize.query(`SELECT * FROM comercial_city_doc_costs ORDER BY ${TIPOS.cidades.ordem}`);
        const [prestadores] = await db.sequelize.query(`SELECT * FROM comercial_providers ORDER BY ${TIPOS.prestadores.ordem}`);
        return res.json({ programas, cidades, prestadores });
    } catch (e) {
        console.error('[conditions] listCadastros:', e);
        return res.status(500).json({ error: 'Não foi possível ler os cadastros.' });
    }
};

export const saveCadastro = async (req, res) => {
    try {
        if (!(await canEditConditions(req))) return res.status(403).json({ error: 'Você não tem permissão para editar fichas comerciais.' });
        const { tipo } = req.params;
        const def = TIPOS[tipo];
        if (!def) return res.status(404).json({ error: 'Cadastro desconhecido.' });
        const id = req.params.id ? Number(req.params.id) : null;
        const { erro, dados } = validar(tipo, req.body || {}, Boolean(id));
        if (erro) return res.status(422).json({ error: erro });
        dados.updated_by = req.user?.id ?? null;
        const cols = Object.keys(dados);
        if (!cols.length) return res.status(400).json({ error: 'Nada para salvar.' });
        let row;
        if (id) {
            const sets = cols.map((c) => `${c} = :${c}`).join(', ');
            const [rows] = await db.sequelize.query(`UPDATE ${def.tabela} SET ${sets}, updated_at = NOW() WHERE id = :id RETURNING *`, { replacements: { ...dados, id } });
            row = rows[0];
            if (!row) return res.status(404).json({ error: 'Registro não encontrado.' });
        } else {
            const [rows] = await db.sequelize.query(`INSERT INTO ${def.tabela} (${cols.join(', ')}) VALUES (${cols.map((c) => `:${c}`).join(', ')}) RETURNING *`, { replacements: dados });
            row = rows[0];
        }
        return res.json(row);
    } catch (e) {
        if (/uq_comercial_city_doc_costs|duplicate key/i.test(e.message)) {
            return res.status(409).json({ error: 'Esta cidade já tem cadastro. Altere o que já existe.' });
        }
        console.error('[conditions] saveCadastro:', e);
        return res.status(500).json({ error: 'Não foi possível salvar o cadastro.' });
    }
};

export const removeCadastro = async (req, res) => {
    try {
        if (!(await canEditConditions(req))) return res.status(403).json({ error: 'Você não tem permissão para editar fichas comerciais.' });
        const def = TIPOS[req.params.tipo];
        if (!def) return res.status(404).json({ error: 'Cadastro desconhecido.' });
        const id = Number(req.params.id);
        if (def.inativa) {
            await db.sequelize.query(`UPDATE ${def.tabela} SET ativo = false, updated_at = NOW(), updated_by = :u WHERE id = :id`, { replacements: { id, u: req.user?.id ?? null } });
        } else {
            await db.sequelize.query(`DELETE FROM ${def.tabela} WHERE id = :id`, { replacements: { id } });
        }
        return res.json({ ok: true });
    } catch (e) {
        console.error('[conditions] removeCadastro:', e);
        return res.status(500).json({ error: 'Não foi possível remover o cadastro.' });
    }
};

export default { listCadastros, saveCadastro, removeCadastro };

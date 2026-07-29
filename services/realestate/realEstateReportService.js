// services/realestate/realEstateReportService.js
//
// Monta o relatório de imobiliárias (backup cv_imobiliarias + vínculos por
// reservas e por cadastros do Office). Extraído do realEstateController para
// ser REUSADO pela Eme (RealEstateTools) com exatamente o mesmo comportamento
// e escopo de acesso da tela /comercial/imobiliarias — não-admin só vê
// imobiliárias das cidades dos empreendimentos do seu escopo
// (accessScopeService), com herança de cidade dos empreendimentos vinculados.

import db from '../../models/sequelize/index.js';
import { visibleCities } from '../permissions/accessScopeService.js';
import { onlyDigits } from './realEstateRegistrationService.js';

// Normalização compatível com a lógica de cidade usada no resto do sistema:
// sem acento, maiúsculas, não-alfanumérico vira espaço.
export const normCity = (s) => ` ${String(s || '')
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, ' ')
    .trim()} `;
export const cityMatches = (value, needle) => {
    const n = normCity(needle);
    return n.trim() ? normCity(value).includes(n) : true;
};

/**
 * Relatório completo de imobiliárias, já escopado ao usuário.
 * @param {object} opts
 * @param {object} opts.user           req.user ({ id, role, city })
 * @param {string} [opts.q]            busca livre (nome/razão/cnpj/gerente)
 * @param {string} [opts.cidade]       filtro por cidade
 * @param {string} [opts.empreendimento] filtro por id ou nome de empreendimento
 * @returns {Promise<{ total:number, last_sync:Date|null, imobiliarias:Array }>}
 */
export async function buildImobiliariasReport({ user, q = '', cidade = '', empreendimento = '' }) {
    // Primeira visita sem backup: sincroniza na hora (uma chamada ao CV).
    const total = await db.CvImobiliaria.count();
    if (!total) {
        const { default: ImobiliariaSyncService } = await import('../bulkData/cv/ImobiliariaSyncService.js');
        await new ImobiliariaSyncService().syncAll().catch(e =>
            console.error('[realestate] sync inicial falhou:', e?.message));
    }

    const [imobs, links, ents, regs] = await Promise.all([
        db.CvImobiliaria.findAll({ order: [['nome', 'ASC']], raw: true }),
        // Vínculo por atividade: reservas ligam imobiliária (cnpj) a empreendimento (nome).
        db.sequelize.query(`
            SELECT DISTINCT (imobiliaria->>'cnpj') AS cnpj, empreendimento
            FROM reservas
            WHERE COALESCE(imobiliaria->>'cnpj', '') <> '' AND COALESCE(empreendimento, '') <> ''
        `, { type: db.Sequelize.QueryTypes.SELECT }),
        db.sequelize.query(
            'SELECT idempreendimento, nome, cidade, foto_listagem, foto, logo, situacao_obra_nome FROM cv_enterprises',
            { type: db.Sequelize.QueryTypes.SELECT }
        ),
        // Vínculo por cadastro do Office: associações escolhidas na criação.
        db.RealEstateRegistration.findAll({ where: { status: 'completed' }, raw: true }),
    ]);

    const entById = new Map(ents.map(e => [Number(e.idempreendimento), e]));
    const entByName = new Map(ents.map(e => [normCity(e.nome).trim(), e]));

    // Card básico do empreendimento no relatório (foto p/ o front).
    const entCard = (hit, fallbackNome) => hit
        ? {
            id: Number(hit.idempreendimento),
            nome: hit.nome,
            cidade: hit.cidade || null,
            foto: hit.foto_listagem || hit.foto || hit.logo || null,
            situacao: hit.situacao_obra_nome || null,
        }
        : { id: null, nome: fallbackNome, cidade: null, foto: null, situacao: null };

    // cnpj → Map(idOuNome → entCard)
    const linksByCnpj = new Map();
    const addLink = (cnpj, ent) => {
        if (!cnpj || !ent?.nome) return;
        const key = onlyDigits(cnpj);
        if (!linksByCnpj.has(key)) linksByCnpj.set(key, new Map());
        linksByCnpj.get(key).set(ent.id ?? normCity(ent.nome).trim(), ent);
    };

    for (const l of links) {
        const hit = entByName.get(normCity(l.empreendimento).trim());
        addLink(l.cnpj, entCard(hit, l.empreendimento));
    }
    // Cadastros do Office: origem (interno x link) + gerente de fallback.
    const regByCnpj = new Map();
    for (const r of regs) {
        const cnpj = onlyDigits(r.form?.imobiliaria?.cnpj);
        if (cnpj) regByCnpj.set(cnpj, r);
        for (const e of (r.enterprises || [])) {
            const hit = entById.get(Number(e.id));
            addLink(cnpj, hit ? entCard(hit) : { id: Number(e.id), nome: e.nome, cidade: null, foto: null, situacao: null });
        }
    }

    const qFilter = String(q || '').trim();
    const cidadeFilter = String(cidade || '').trim();
    const entFilter = String(empreendimento || '').trim();
    // Escopo de acesso (accessScopeService): null = admin (sem filtro);
    // lista de cidades dos empreendimentos liberados. Fail-closed: vazio → nada.
    const scopeCities = await visibleCities(user);

    const rows = [];
    for (const i of imobs) {
        const vinculos = [...(linksByCnpj.get(onlyDigits(i.cnpj)) || new Map()).values()];
        // Cidade efetiva: a da própria imobiliária; sem endereço, herda as
        // cidades dos empreendimentos vinculados.
        const cidades = i.cidade
            ? [i.cidade]
            : [...new Set(vinculos.map(v => v.cidade).filter(Boolean))];

        // Escopo de acesso: não-admin só vê imobiliárias das cidades do escopo.
        if (scopeCities !== null) {
            if (!cidades.length || !scopeCities.length) continue;
            if (!cidades.some(c => scopeCities.some(sc => cityMatches(c, sc)))) continue;
        }

        if (cidadeFilter && !cidades.some(c => cityMatches(c, cidadeFilter))) continue;
        if (entFilter && !vinculos.some(v =>
            String(v.id) === entFilter || cityMatches(v.nome, entFilter))) continue;
        if (qFilter) {
            const alvo = normCity(`${i.nome} ${i.razao_social} ${i.cnpj} ${i.gerente_nome || ''}`);
            if (!alvo.includes(normCity(qFilter))) continue;
        }

        // Origem: cadastrada pelo Office (via link público ou tela interna)
        // ou direto no CV. O codigointerno OFFICE-<id> cobre cadastros cujo
        // registro local se perdeu.
        const reg = regByCnpj.get(onlyDigits(i.cnpj));
        const origem = reg
            ? (reg.source === 'public' ? 'link' : 'office')
            : (String(i.raw?.codigointerno || '').startsWith('OFFICE-') ? 'office' : 'cv');

        // Gerente: campos do CV; vazios em cadastros do Office (o gerente lá
        // vira usuário-imobiliária) → fallback para o formulário enviado.
        const regGer = reg?.form?.gerente || {};

        rows.push({
            idimobiliaria: i.idimobiliaria,
            nome: i.nome,
            razao_social: i.razao_social,
            cnpj: i.cnpj,
            sigla: i.sigla,
            creci: i.creci,
            validade_creci: i.validade_creci,
            ativo: i.ativo,
            ativo_painel: i.ativo_painel,
            micro_empresa: i.micro_empresa,
            origem,
            email: i.email,
            telefone: i.telefone,
            celular: i.celular,
            gerente_nome: i.gerente_nome || regGer.nome || null,
            gerente_email: i.gerente_email || regGer.email || null,
            gerente_celular: i.gerente_celular || regGer.celular || null,
            gerente_telefone: i.raw?.gerente_telefone || regGer.telefone || null,
            gerente_cpf: i.raw?.gerente_cpf || regGer.documento || null,
            cidade: i.cidade,
            estado: i.estado,
            cidades,
            cidade_origem: i.cidade ? 'imobiliaria' : (cidades.length ? 'empreendimentos' : null),
            empreendimentos: vinculos.sort((a, b) => String(a.nome).localeCompare(String(b.nome))),
            data_cad: i.data_cad,
            synced_at: i.synced_at,
        });
    }

    const lastSync = imobs.reduce((max, i) =>
        (!max || (i.synced_at && i.synced_at > max)) ? i.synced_at : max, null);

    return { total: rows.length, last_sync: lastSync, imobiliarias: rows };
}

export default { buildImobiliariasReport, normCity, cityMatches };

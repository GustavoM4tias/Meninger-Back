// services/bulkData/cv/ImobiliariaSyncService.js
//
// Backup das imobiliárias do CV em cv_imobiliarias. A listagem
// GET /v1/cadastros/imobiliarias devolve TODAS de uma vez, já com cidade e
// estado resolvidos — uma chamada sincroniza tudo (medido em 2026-08-24: 555
// registros, sem bloco `paginacao` na resposta). `syncOne` atualiza um
// registro específico (usado logo após um cadastro feito pelo Office).
//
// A listagem só devolve imobiliárias ATIVAS. Quem sai dela foi desativada ou
// excluída no CV, e antes ficava no espelho como ativa para sempre — fantasma
// na tela, com contato que não vale mais. Agora o sync marca os ausentes como
// inativos, então a tela mostra "Inativa" em vez de mentir.

import { Op } from 'sequelize';
import apiCv from '../../../lib/apiCv.js';
import db from '../../../models/sequelize/index.js';

// O CV devolve texto com entidade HTML crua ("CHAVE &amp; CO. ASSOCIADOS").
// Sem decodificar, a entidade aparece literal na tela e ainda estraga a busca.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(value) {
    if (typeof value !== 'string' || !value.includes('&')) return value;
    return value
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

const txt = (value) => decodeEntities(value) || null;

function toRow(item) {
    return {
        idimobiliaria: Number(item.idimobiliaria),
        nome: txt(item.nome),
        razao_social: txt(item.razao_social),
        cnpj: String(item.cnpj || '').replace(/\D/g, '') || null,
        sigla: txt(item.sigla),
        creci: txt(item.creci),
        validade_creci: item.validade_creci || null,
        ativo: item.ativo || null,
        ativo_painel: item.ativo_painel || null,
        micro_empresa: item.micro_empresa || null,
        email: txt(item.email),
        telefone: txt(item.telefone),
        celular: txt(item.celular),
        cidade: txt(item.cidade),
        estado: txt(item.estado),
        gerente_nome: txt(item.gerente_nome),
        gerente_email: txt(item.gerente_email),
        gerente_celular: txt(item.gerente_celular),
        data_cad: item.data_cad || null,
        data_modificacao: item.data_modificacao || null,
        raw: item,
        synced_at: new Date(),
    };
}

export default class ImobiliariaSyncService {
    async syncAll() {
        const resp = await apiCv.get('/v1/cadastros/imobiliarias');
        const list = Array.isArray(resp?.data?.imobiliarias) ? resp.data.imobiliarias : [];

        const vistos = [];
        for (const item of list) {
            const id = Number(item?.idimobiliaria);
            if (!Number.isFinite(id)) continue;
            await db.CvImobiliaria.upsert(toRow(item));
            vistos.push(id);
        }

        // Poda: quem não veio na listagem não está mais ativo no CV. Só roda
        // quando a resposta trouxe conteúdo — resposta vazia é falha do CV, e
        // desativar a base inteira por causa dela seria bem pior.
        if (vistos.length) {
            const [desativadas] = await db.CvImobiliaria.update(
                { ativo: 'N', synced_at: new Date() },
                { where: { idimobiliaria: { [Op.notIn]: vistos }, ativo: { [Op.ne]: 'N' } } }
            );
            if (desativadas) console.log(`[Imobiliárias] ${desativadas} marcada(s) como inativa(s) (sumiram do CV)`);
        }

        return vistos.length;
    }

    async syncOne(idimobiliaria) {
        const id = Number(idimobiliaria);
        if (!Number.isFinite(id)) return null;
        const resp = await apiCv.get(`/v1/cadastros/imobiliarias/${id}`);
        const item = resp?.data?.imobiliarias;
        if (!item?.idimobiliaria) return null;
        await db.CvImobiliaria.upsert(toRow(item));
        return item;
    }
}

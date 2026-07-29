// /src/controllers/cv/empreendimentosDb.js
import crypto from 'crypto';
import db from '../../models/sequelize/index.js';
import { summarizeUnitsFromDb } from '../../services/cv/enterpriseUnitsSummaryService.js';
import { visibleCvIds } from '../../services/permissions/accessScopeService.js';
const {
  CvEnterprise, CvEnterpriseStage, CvEnterpriseBlock, CvEnterpriseUnit,
  CvEnterpriseMaterial, CvEnterprisePlan
} = db;
const { Op } = db.Sequelize;

// cache simples opcional (30s)
const cache = new Map();
const TTL = 30_000;

// Chave de cache por escopo: 'all' para admin, hash da lista de ids vis\u00edveis
// para n\u00e3o-admin (usu\u00e1rios com o mesmo escopo compartilham o cache).
const scopeCacheKey = (ids) => {
  if (ids === null) return 'all';
  const sorted = [...ids].sort((a, b) => a - b).join(',');
  return crypto.createHash('sha1').update(sorted).digest('hex').slice(0, 16);
};

export const fetchBuildingsFromDb = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Usuário não autenticado.' });
    }

    // Escopo de acesso: null = admin (sem filtro), [] = nada visível
    const allowedIds = await visibleCvIds(req.user);
    const isAdmin = allowedIds === null;

    // ----- CACHE (30s), chave por escopo -----
    const key = `list:${scopeCacheKey(allowedIds)}`;
    const now = Date.now();
    const memo = cache.get(key);
    if (memo && now - memo.ts < TTL) {
      res.set('X-Cache', 'HIT');
      return res.json(memo.data);
    }

    // ----- CAMPOS MINIMOS -----
    const fields = [
      "idempreendimento", "idempreendimento_int", "nome",
      "regiao", "cidade", "estado", "bairro",
      "endereco_emp", "numero", "logradouro", "cep",
      "endereco", "idempresa", "sigla",
      "logo", "foto_listagem", "foto",
      "app_exibir", "app_cor_background",
      "data_entrega", "andamento", "unidades_disponiveis",
      "situacao_obra_nome", "situacao_comercial_nome",
      "tipo_empreendimento_nome", "segmento_nome",
      "raw"
    ];

    // ----- FILTRO POR ESCOPO (accessScopeService) -----
    // Não-admin: só enxerga os idempreendimentos do seu escopo de acesso.
    const where = {};
    if (!isAdmin) {
      if (!allowedIds.length) {
        // Nada permitido para este escopo: devolve lista vazia (e cacheia).
        cache.set(key, { ts: now, data: [] });
        res.set('X-Cache', 'MISS');
        return res.json([]);
      }

      where.idempreendimento = { [Op.in]: allowedIds };
    }

    // ----- BUSCA SQL -----
    const rows = await CvEnterprise.findAll({
      attributes: fields,
      where,
      order: [['nome', 'ASC']]
    });

    // ----- MONTAR PAYLOAD (leve) -----
    const payload = rows.map(r => {
      const raw = r.raw || {};

      return {
        idempreendimento: r.idempreendimento,
        idempreendimento_int: r.idempreendimento_int ?? raw.idempreendimento_int ?? null,
        referencia_externa: raw.referencia_externa ?? null,
        nome: r.nome,
        regiao: r.regiao,
        cidade: r.cidade,
        estado: r.estado,
        bairro: r.bairro,
        endereco_emp: r.endereco_emp,
        numero: r.numero,
        logradouro: r.logradouro,
        cep: r.cep,
        endereco: r.endereco,
        idempresa: r.idempresa,
        sigla: r.sigla,

        link_disponibilidade:
          raw.link_disponibilidade ??
          (r.idempreendimento
            ? `https://menin.cvcrm.com.br/gestor/comercial/mapadisponibilidade/${r.idempreendimento}`
            : null),

        logo: r.logo,
        foto_listagem: r.foto_listagem,
        foto: r.foto,

        app_exibir: r.app_exibir,
        app_cor_background: r.app_cor_background,
        data_entrega: r.data_entrega,
        andamento: r.andamento ? Number(r.andamento) : null,
        unidades_disponiveis: r.unidades_disponiveis,

        situacao_obra: raw.situacao_obra ?? (r.situacao_obra_nome ? [{ nome: r.situacao_obra_nome }] : []),
        situacao_comercial: raw.situacao_comercial ?? (r.situacao_comercial_nome ? [{ nome: r.situacao_comercial_nome }] : []),
        tipo_empreendimento: raw.tipo_empreendimento ?? (r.tipo_empreendimento_nome ? [{ nome: r.tipo_empreendimento_nome }] : []),
        segmento: raw.segmento ?? (r.segmento_nome ? [{ nome: r.segmento_nome }] : []),
      };
    });

    // ----- SALVA NO CACHE -----
    cache.set(key, { ts: now, data: payload });
    res.set('X-Cache', 'MISS');

    return res.json(payload);

  } catch (err) {
    console.error('Erro ao buscar empreendimentos (DB):', err);
    return res.status(500).json({ error: 'Erro ao buscar empreendimentos no banco' });
  }
};

export const fetchBuildingByIdFromDb = async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Usuário não autenticado.' });
  }
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: "O parâmetro 'id' é obrigatório." });

  // ── Visibilidade: não-admin só vê empreendimentos do seu escopo ──
  const allowedIds = await visibleCvIds(req.user); // null = admin (sem filtro)
  const isAdmin = allowedIds === null;

  // cache scoped por escopo/admin para não vazar entre usuários
  const key = `ent:${id}:${scopeCacheKey(allowedIds)}`;
  const now = Date.now();
  const memo = cache.get(key);
  if (memo && now - memo.ts < TTL) {
    res.set('X-Cache', 'HIT');
    return res.json(memo.data);
  }

  // aumenta timeout do response (se precisar)
  res.setTimeout(120000);

  try {
    // 1) busca o enterprise "seco"
    const ent = await CvEnterprise.findByPk(id);
    if (!ent) return res.status(404).json({ error: 'Empreendimento não encontrado.' });

    // 1.1) Não-admin: confirma que o empreendimento está no seu escopo
    // (fail-closed: escopo vazio → nada visível)
    if (!isAdmin && !allowedIds.includes(Number(id))) {
      return res.status(403).json({ error: 'Empreendimento fora do seu escopo.' });
    }

    // 2) busca filhos em paralelo (SEM include)
    const [
      etapas,
      materiais,
      plantas
    ] = await Promise.all([
      CvEnterpriseStage.findAll({
        where: { idempreendimento: id },
        order: [['data_cad', 'ASC'], ['idetapa', 'ASC']]
      }),
      CvEnterpriseMaterial.findAll({ where: { idempreendimento: id }, order: [['idarquivo', 'ASC']] }),
      CvEnterprisePlan.findAll({ where: { idempreendimento: id }, order: [['idplanta_mapeada', 'ASC']] }),
    ]);

    // 3) blocos por etapas (ids)
    const etapaIds = etapas.map(e => e.idetapa);
    const blocos = etapaIds.length
      ? await CvEnterpriseBlock.findAll({
        where: { idetapa: etapaIds },
        order: [['nome', 'ASC'], ['idbloco', 'ASC']],
        // pegue também totais/paginação persistidos
        attributes: { exclude: [] }
      })
      : [];

    // 4) unidades por blocos (ids)
    const blocoIds = blocos.map(b => b.idbloco);
    const unidades = blocoIds.length
      ? await CvEnterpriseUnit.findAll({
        where: { idbloco: blocoIds },
        order: [['idunidade', 'ASC']],
        attributes: { exclude: [] } // traga tudo que você salvou (inclui raw)
      })
      : [];

    // 5) indexações em memória (O(n)) para agrupar rápido
    const unitsByBlock = new Map();
    for (const u of unidades) {
      const arr = unitsByBlock.get(u.idbloco) || [];
      arr.push(u);
      unitsByBlock.set(u.idbloco, arr);
    }

    const blocksByStage = new Map();
    for (const b of blocos) {
      const units = unitsByBlock.get(b.idbloco) || [];

      const arr = blocksByStage.get(b.idetapa) || [];
      arr.push({
        idbloco: b.idbloco,
        idbloco_int: b.idbloco_int ?? null,
        idetapa: b.idetapa,
        nome: b.nome ?? null,
        data_cad: b.data_cad ?? null,

        // 🔴 AGORA: paginação sempre espelha o que veio das unidades reais
        paginacao_unidade: {
          total: units.length,
          limite_dados_unidade: units.length,
          pagina_unidade: 1,
          paginas_total: units.length > 0 ? 1 : 0,
        },

        unidades: units.map(u => ({
          nome: u.nome,
          area_privativa: u.area_privativa != null ? Number(u.area_privativa).toFixed(6) : null,
          idunidade: u.idunidade,
          idunidade_int: u.idunidade_int,
          idbloco: u.idbloco,
          vagas_garagem: u.vagas_garagem,
          vagas_garagem_qtde: u.vagas_garagem_qtde,
          andar: u.andar,
          area_comum: u.area_comum != null ? Number(u.area_comum).toFixed(6) : null,
          coluna: u.coluna,
          posicao: u.posicao,
          tipologia: u.tipologia,
          tipo: u.tipo,
          idtipo_int: u.idtipo_int,
          empresa_terceirizacao: u.raw?.empresa_terceirizacao ?? null,
          valor: u.valor != null ? Number(u.valor).toFixed(2) : null,
          valor_avaliacao: u.valor_avaliacao != null ? Number(u.valor_avaliacao).toFixed(2) : null,
          data_bloqueio: u.data_bloqueio,
          data_entrega: u.data_entrega,
          data_entrega_chaves: u.data_entrega_chaves,
          agendar_a_partir: u.agendar_a_partir,
          liberar_a_partir: u.liberar_a_partir,
          situacao: {
            situacao_mapa_disponibilidade: u.situacao_mapa_disponibilidade ?? null,
          },
          plantas: u.raw?.plantas ?? []
        })),
      });
      blocksByStage.set(b.idetapa, arr);
    }

    const etapasOut = etapas.map(e => ({
      idetapa: e.idetapa,
      idetapa_int: e.idetapa_int ?? null,
      idempreendimento: e.idempreendimento,
      nome: e.nome ?? null,
      data_cad: e.data_cad ?? null,
      blocos: blocksByStage.get(e.idetapa) || []
    }));

    // 6) shape final (idêntico ao CV)
    const raw = ent.raw || {};
    const payload = {
      idempreendimento: ent.idempreendimento,
      idempreendimento_int: ent.idempreendimento_int ?? raw.idempreendimento_int ?? null,
      referencia_externa: raw.referencia_externa ?? null,
      nome: ent.nome,
      matricula: ent.matricula ?? raw.matricula ?? null,
      regiao: ent.regiao ?? raw.regiao ?? null,
      cidade: ent.cidade,
      estado: ent.estado,
      bairro: ent.bairro ?? raw.bairro ?? null,
      endereco_emp: ent.endereco_emp ?? raw.endereco_emp ?? null,
      numero: ent.numero ?? raw.numero ?? null,
      logradouro: ent.logradouro ?? raw.logradouro ?? null,
      cep: ent.cep ?? raw.cep ?? null,
      endereco: ent.endereco ?? raw.endereco ?? null,

      idempresa: ent.idempresa ?? raw.idempresa ?? null,
      idempresa_int: raw.idempresa_int ?? null,
      nome_empresa: ent.nome_empresa ?? raw.nome_empresa ?? null,
      razao_social_empesa: ent.razao_social_empesa ?? raw.razao_social_empesa ?? null,
      cnpj_empesa: ent.cnpj_empesa ?? raw.cnpj_empesa ?? null,
      endereco_empresa: ent.endereco_empresa ?? raw.endereco_empresa ?? null,

      integrado: raw.integrado ?? null,

      logo: ent.logo ?? raw.logo ?? null,
      foto: ent.foto ?? raw.foto ?? null,

      latitude: ent.latitude != null ? String(ent.latitude) : (raw.latitude ?? null),
      longitude: ent.longitude != null ? String(ent.longitude) : (raw.longitude ?? null),

      titulo: ent.titulo ?? raw.titulo ?? null,
      descricao: ent.descricao ?? raw.descricao ?? null,
      data_entrega: ent.data_entrega ?? raw.data_entrega ?? null,

      situacao_obra: raw.situacao_obra ?? [],
      situacao_comercial: raw.situacao_comercial ?? [],
      tipo_empreendimento: raw.tipo_empreendimento ?? [],
      segmento: raw.segmento ?? [],

      etapas: etapasOut,

      plantas: raw.plantas ?? [],
      caracteristicas: raw.caracteristicas ?? [],

      tabela: ent.tabela ?? raw.tabela ?? null,

      materiais_campanha: materiais.map(m => ({
        idarquivo: m.idarquivo,
        nome: m.nome,
        tipo: m.tipo,
        tamanho: m.tamanho,
        arquivo: m.arquivo,
        servidor: m.servidor
      })),

      plantas_mapeadas: plantas.map(p => ({
        idplanta_mapeada: p.idplanta_mapeada,
        nome: p.nome,
        link: p.link,
        pontos: Array.isArray(p.raw?.pontos) ? p.raw.pontos : undefined
      }))
    };

    cache.set(key, { ts: now, data: payload });
    res.set('X-Cache', 'MISS');
    return res.json(payload);
  } catch (err) {
    console.error('Erro no detalhe do empreendimento:', err);
    return res.status(500).json({ error: 'Erro ao montar empreendimento.' });
  }
}; 

export const fetchBuildingUnitsSummaryFromDb = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Usuário não autenticado.' });
    }

    const { id } = req.params; // idempreendimento (CV)
    const cvEnterpriseId = Number(id);

    if (!cvEnterpriseId) {
      return res.status(400).json({ error: "Parâmetro 'id' inválido." });
    }

    const summary = await summarizeUnitsFromDb(cvEnterpriseId);

    return res.json({
      cvEnterpriseId,
      ...summary
    });
  } catch (err) {
    console.error('Erro ao resumir unidades do empreendimento (DB):', err);
    return res.status(500).json({ error: 'Erro ao resumir unidades do empreendimento.' });
  }
};
  
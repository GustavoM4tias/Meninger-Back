// src/controllers/sienge/contratos.js
import apiSienge from '../../lib/apiSienge.js';
import dayjs from 'dayjs';
import isBetween from 'dayjs/plugin/isBetween.js';
dayjs.extend(isBetween);

const contratosCache = new Map();
const CACHE_TTL = 1000 * 60 * 10; // 10 minutos
const BLOCK_SIZE = 200;

export const fetchContratos = async (req, res) => {
  try {
    const { companyId, enterpriseId, enterpriseName, startDate, endDate, linkedEnterprises } = req.query;
    const hoje = dayjs();
    const start = startDate ? dayjs(startDate) : hoje.startOf('month');
    const end = endDate ? dayjs(endDate) : hoje;
    // linkedEnterprises = "78001:17004,10101:18915"

    console.log(`🔍 Busca solicitada: ${start.format('YYYY-MM-DD')} → ${end.format('YYYY-MM-DD')}`);

    // cache por startDate
    // única cache global
    let cache = contratosCache.get('global');

    // expira cache se velho
    if (cache && Date.now() - cache.timestamp > CACHE_TTL) {
      console.log('🕑 Cache expirado, limpando...');
      contratosCache.delete('global');
      cache = undefined;
    }

    // inicializa cache vazio se necessário
    if (!cache) {
      console.log('📭 Cache vazio. Criando novo global...');
      cache = {
        raw: [],               // todos contratos já carregados
        timestamp: Date.now(), // último fetch
        earliest: hoje,        // data mais antiga carregada
      };
      contratosCache.set('global', cache);
    }

    // calcula blocos necessários com nova lógica
    const BASE_BLOCKS = 10;
    const DIAS_POR_BLOCO_EXTRA = 60;
    const diasNoPassado = hoje.diff(start, 'day');

    const blocosExtras = Math.floor(diasNoPassado / DIAS_POR_BLOCO_EXTRA);
    const neededBlocks = BASE_BLOCKS + blocosExtras;

    console.log(`📊 ${diasNoPassado} dias no passado → ${neededBlocks} blocos (base=${BASE_BLOCKS}, extra=${blocosExtras})`);

    // quantos blocos já carregamos
    let loadedBlocks = Math.ceil(cache.raw.length / BLOCK_SIZE);

    // se precisamos de mais blocos, busca apenas os faltantes
    if (loadedBlocks < neededBlocks) {
      const toLoad = neededBlocks - loadedBlocks;
      console.log(`🆕 Carregando blocos faltantes: ${toLoad}`);
      for (let i = 0; i < toLoad; i++) {
        const offset = cache.raw.length;
        console.log(`🔁 Buscando bloco ${loadedBlocks + i + 1}/${neededBlocks} (offset=${offset})`);
        const { data } = await apiSienge.get('/v1/sales-contracts', {
          params: { limit: BLOCK_SIZE, offset, situation: '2' }
        });
        console.log({ limit: BLOCK_SIZE, offset, situation: '2' })
        const bloc = data.results || [];
        cache.raw.push(...bloc);
        cache.timestamp = Date.now();
        console.log(`📥 Recebidos ${bloc.length} contratos`);
        if (bloc.length < BLOCK_SIZE) break;
      }
      console.log(`📦 Cache global agora tem ${cache.raw.length} contratos`);
    } else {
      console.log(`✅ Cache global já possui ${cache.raw.length} contratos`);
    }

    const filtered = cache.raw.filter(c => {
      let dataReferencia = null;

      if (c.financialInstitutionDate && dayjs(c.financialInstitutionDate).isValid()) {
        dataReferencia = dayjs(c.financialInstitutionDate);
      } else if (c.contractDate && dayjs(c.contractDate).isValid()) {
        dataReferencia = dayjs(c.contractDate);
        c.__usouDataContrato = true;
      } else {
        return false;
      }

      if (!dataReferencia.isBetween(start, end, null, '[]')) return false;

      if (companyId) {
        const ids = Array.isArray(companyId) ? companyId : [companyId];
        if (!ids.includes(String(c.companyId))) return false;
      }

      // 🔥 Filtro com expansão de pares vinculados
      if (enterpriseId) {
        const rawIds = Array.isArray(enterpriseId) ? enterpriseId : [enterpriseId];
        let expandedEnterpriseIds = rawIds;

        if (linkedEnterprises) {
          const linkPairs = linkedEnterprises.split(',').map(pair => pair.split(':'));
          const linkSet = new Set();

          for (const id of rawIds) {
            for (const [a, b] of linkPairs) {
              if (a === id || b === id) {
                linkSet.add(a);
                linkSet.add(b);
              }
            }
          }

          expandedEnterpriseIds = Array.from(new Set([...rawIds, ...linkSet]));
        }

        if (!expandedEnterpriseIds.includes(String(c.enterpriseId))) return false;
      }

      if (enterpriseName) {
        const nomes = Array.isArray(enterpriseName) ? enterpriseName : [enterpriseName];
        if (!nomes.some(n => c.enterpriseName.includes(n))) return false;
      }

      return true;
    });
    // agrupa contratos vinculados por cliente e linkedEnterprises
    const linkMap = new Map();
    if (linkedEnterprises) {
      linkedEnterprises.split(',').forEach(pair => {
        const [a, b] = pair.split(':');
        linkMap.set(a, a);
        linkMap.set(b, a);
      });
    }
    const groups = new Map();
    for (const c of filtered) {
      const cust = c.salesContractCustomers?.[0];
      if (!cust) continue;
      const custId = cust.id;
      const entKey = linkMap.get(String(c.enterpriseId)) || String(c.enterpriseId);
      const key = `${custId}#${entKey}`;
      if (!groups.has(key)) {
        groups.set(key, {
          customerId: custId,
          customerName: cust.name,
          groupEnterprise: entKey,
          enterpriseIds: new Set(),
          contracts: []
        });
      }
      const g = groups.get(key);
      g.enterpriseIds.add(String(c.enterpriseId));
      g.contracts.push(c);
    }

    // prepara resultado unificado
    const results = Array.from(groups.values()).map(g => ({
      customerId: g.customerId,
      customerName: g.customerName,
      groupEnterprise: g.groupEnterprise,
      enterpriseIds: Array.from(g.enterpriseIds),
      contracts: g.contracts
    }));

    console.log(`🔄 Retornando ${results.length} grupos de contratos`);
    return res.json({ count: results.length, results }); ({ count: resultGroups.length, results: resultGroups }); ({ count: filtered.length, results: filtered });
  } catch (err) {
    console.error('❌ Erro ao buscar contratos:', err);
    return res.status(500).json({ error: 'Erro ao buscar contratos do Sienge.' });
  }
};

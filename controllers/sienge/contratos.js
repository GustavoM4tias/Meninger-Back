// src/controllers/sienge/contratos.js
import apiSienge from '../../lib/apiSienge.js';
import dayjs from 'dayjs';

// Cache em memória com tempo de expiração
const contratosCache = new Map()
const CACHE_TTL = 1000 * 60 * 5 // 5 minutos
/**
 * Utilitário para buscar contratos de venda do Sienge com paginação automática
 * e filtros por data, situação, empresa, empreendimento e distrato.
 */
export const fetchContratos = async (req, res) => {
  try {
    const {
      companyId,
      enterpriseId,
      enterpriseName,
      situation, // array de strings, ex: ['0', '1']
      initialIssueDate,
      finalIssueDate,
      initialCancelDate,
      finalCancelDate,
      distrato = false
    } = req.query;

    const today = dayjs().format('YYYY-MM-DD');
    const firstDayOfMonth = dayjs().startOf('month').format('YYYY-MM-DD');

    // Define as datas padrão com base no tipo de busca (normal ou distrato)
    const defaultInitialDate = initialIssueDate || firstDayOfMonth;
    const defaultFinalDate = finalIssueDate || today;
    const defaultInitialCancel = initialCancelDate || firstDayOfMonth;
    const defaultFinalCancel = finalCancelDate || today;

    // Cria uma chave única para o cache
    const cacheKey = JSON.stringify({
      companyId,
      enterpriseId,
      enterpriseName,
      situation,
      defaultInitialDate,
      defaultFinalDate,
      defaultInitialCancel,
      defaultFinalCancel,
      distrato,
    })

    // Verifica o cache
    if (contratosCache.has(cacheKey)) {
      const { timestamp, data } = contratosCache.get(cacheKey)
      if (Date.now() - timestamp < CACHE_TTL) {
        return res.status(200).json(data)
      } else {
        contratosCache.delete(cacheKey) // expira
      }
    }

    const limit = 200;
    let offset = 0;
    let allResults = [];
    let keepFetching = true;

    while (keepFetching) {
      const params = {
        limit,
        offset,
        ...(companyId && { companyId }),
        ...(enterpriseId && { enterpriseId }),
        ...(enterpriseName && { enterpriseName }),
        ...(situation && { situation: Array.isArray(situation) ? situation : [situation] }),
        ...(distrato === 'true'
          ? {
            initialCancelDate: defaultInitialCancel,
            finalCancelDate: defaultFinalCancel
          }
          : {
            initialIssueDate: defaultInitialDate,
            finalIssueDate: defaultFinalDate
          })
      };

      const { data } = await apiSienge.get('/v1/sales-contracts', { params });

      if (data?.results?.length) {
        allResults = allResults.concat(data.results);
        offset += limit;
        keepFetching = data.results.length === limit;
      } else {
        keepFetching = false;
      }
    }

    const result = { count: allResults.length, results: allResults }

    // Salva no cache
    contratosCache.set(cacheKey, { timestamp: Date.now(), data: result })

    res.status(200).json(result)
  } catch (error) {
    console.error('Erro ao buscar contratos:', error);
    res.status(500).json({ error: 'Erro ao buscar contratos do Sienge.' });
  }
};



// Nenhum é obrigatório, mas se não houver datas, o sistema usará:

// initialIssueDate = 1º dia do mês atual

// finalIssueDate = hoje

// | Parâmetro           | Tipo       | Exemplo             | Observações                                                |
// | ------------------- | ---------- | ------------------- | ---------------------------------------------------------- |
// | `companyId`         | `integer`  | `1`                 | Código da empresa                                          |
// | `enterpriseId`      | `integer`  | `10`                | ID do empreendimento                                       |
// | `enterpriseName`    | `string`   | `\"Residencial X\"` | Nome do empreendimento (busca parcial)                     |
// | `situation`         | `string[]` | `['0','1','2']`     | Situação do contrato: 0 = Solicitado, 1 = Autorizado, etc. |
// | `initialIssueDate`  | `string`   | `2025-06-01`        | Padrão: primeiro dia do mês                                |
// | `finalIssueDate`    | `string`   | `2025-06-13`        | Padrão: hoje                                               |
// | `initialCancelDate` | `string`   | `2025-06-01`        | Usado somente se `distrato=true`                           |
// | `finalCancelDate`   | `string`   | `2025-06-13`        | Usado somente se `distrato=true`                           |
// | `distrato`          | `boolean`  | `true`              | Se true, busca por contratos cancelados                    |

// 📌 Exemplos de uso da URL:
// Buscar contratos do mês atual (padrão):

// bash
// GET /api/sienge/contratos
// Buscar contratos de uma empresa e empreendimento:

// bash
// GET /api/sienge/contratos?companyId=1&enterpriseId=10
// Buscar contratos emitidos entre duas datas:

// bash
// GET /api/sienge/contratos?initialIssueDate=2025-05-01&finalIssueDate=2025-05-31
// Buscar distratos do mês atual:

// bash
// GET /api/sienge/contratos?distrato=true
// Buscar apenas contratos na situação 'Emitido' (2) ou 'Cancelado' (3):

// bash
// GET /api/sienge/contratos?situation=2&situation=3

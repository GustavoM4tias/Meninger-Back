import apiCv from '../../lib/apiCv.js';

let repasseCache = {
  dados: [],
  timestamp: 0,
  expiracaoMs: 3600000 // 1 hora
};

export const getRepasseWorkflow = async () => {
  try {
    const agora = Date.now();

    if (repasseCache.dados.length > 0 && (agora - repasseCache.timestamp) < repasseCache.expiracaoMs) {
      console.log('Retornando dados de workflow de repasses do cache');
      return repasseCache.dados;
    }

    const { data } = await apiCv.get('/v1/cv/workflow/repasses');
    const dadosOrdenados = data.sort((a, b) => a.ordem - b.ordem);

    const grupos = {};
    dadosOrdenados.forEach(item => {
      if (item.grupos?.length > 0) {
        item.grupos.forEach(grupo => {
          if (!grupos[grupo.idgrupo]) {
            grupos[grupo.idgrupo] = {
              id: grupo.idgrupo,
              nome: grupo.nome,
              cor: item.cor_bg,
              cor_texto: item.cor_nome,
              situacoes: []
            };
          }
          grupos[grupo.idgrupo].situacoes.push({
            id: item.idsituacao,
            nome: item.nome
          });
        });
      }
    });

    const gruposArray = Object.values(grupos);

    repasseCache = {
      dados: {
        situacoes: dadosOrdenados,
        grupos: gruposArray
      },
      timestamp: agora,
      expiracaoMs: 3600000
    };

    return repasseCache.dados;
  } catch (error) {
    console.error('Erro ao buscar workflow de repasses:', error);
    throw error;
  }
};

export const contarRepassesPorSituacao = (repasses) => {
  const contagem = {};
  if (!Array.isArray(repasses)) return contagem;

  repasses.forEach(repasse => {
    const situacao = repasse.situacao?.id;
    if (situacao) contagem[situacao] = (contagem[situacao] || 0) + 1;
  });

  return contagem;
};

export const contarRepassesPorGrupo = (repasses, workflowData) => {
  const contagemSituacoes = contarRepassesPorSituacao(repasses);
  const contagemGrupos = {};

  if (!workflowData?.grupos) return contagemGrupos;

  workflowData.grupos.forEach(grupo => {
    let total = 0;
    grupo.situacoes.forEach(situacao => {
      total += contagemSituacoes[situacao.id] || 0;
    });

    contagemGrupos[grupo.id] = {
      nome: grupo.nome,
      total
    };
  });

  return contagemGrupos;
};

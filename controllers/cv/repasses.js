import {
  getRepasseWorkflow,
  contarRepassesPorSituacao,
  contarRepassesPorGrupo
} from '../../services/cv/repasseWorkflowService.js';

import { getEmpreendimentos } from '../../services/cv/empreendimentoService.js';
import apiCv from '../../lib/apiCv.js';

export const fetchRepasses = async (req, res) => {
  try {
    const { empreendimento, mostrarCancelados, mostrarDistratos, mostrarCessoes } = req.query;

    const exibirCancelados = mostrarCancelados === 'true';
    const exibirDistratos = mostrarDistratos === 'true';
    const exibirCessoes = mostrarCessoes === 'true';

    const limit = 0;
    let allRepasses = [];
    let totalConteudo = 0;

    const buscarPorEmpreendimento = async (emp) => {
      let offset = 0;
      let repassesEmp = [];
      let totalEmp = 0;

      do {
        const url = `/v1/financeiro/repasses?total=${limit}&limit=${limit}&offset=${offset}&empreendimento=${encodeURIComponent(emp)}`;

        const { data } = await apiCv.get(url);

        if (data.repasses && Array.isArray(data.repasses)) {
          const repassesFiltrados = data.repasses.filter(repasse => {
            if (repasse.status_repasse === 'Cancelado' && !exibirCancelados) return false;
            if (repasse.status_repasse === 'Distrato' && !exibirDistratos) return false;
            if (repasse.status_repasse === 'Cessão' && !exibirCessoes) return false;
            return true;
          });
          repassesEmp = repassesEmp.concat(repassesFiltrados);
        }

        totalEmp = data.totalConteudo;
        if (!data.repasses || data.repasses.length === 0) break;
        offset += data.repasses.length;
      } while (repassesEmp.length < totalEmp);

      return { repasses: repassesEmp, total: totalEmp };
    };

    if (empreendimento) {
      const listaEmpreendimentos = empreendimento.split(',').map(emp => emp.trim()).filter(Boolean);
      for (const emp of listaEmpreendimentos) {
        const { repasses, total } = await buscarPorEmpreendimento(emp);
        allRepasses = allRepasses.concat(repasses);
        totalConteudo += total;
      }
    } else {
      let offset = 0;
      do {
        const url = `/v1/financeiro/repasses?total=${limit}&limit=${limit}&offset=${offset}`;
        const { data } = await apiCv.get(url);

        if (data.repasses && Array.isArray(data.repasses)) {
          const repassesFiltrados = data.repasses.filter(repasse => {
            if (repasse.status_repasse === 'Cancelado' && !exibirCancelados) return false;
            if (repasse.status_repasse === 'Distrato' && !exibirDistratos) return false;
            if (repasse.status_repasse === 'Cessão' && !exibirCessoes) return false;
            return true;
          });
          allRepasses = allRepasses.concat(repassesFiltrados);
        }

        totalConteudo = data.totalConteudo;
        if (!data.repasses || data.repasses.length === 0) break;
        offset += data.repasses.length;
      } while (allRepasses.length < totalConteudo);
    }

    const empreendimentos = await getEmpreendimentos();
    allRepasses = allRepasses.reverse();

    const workflowData = await getRepasseWorkflow();
    const contagemSituacoes = contarRepassesPorSituacao(allRepasses);
    const contagemGrupos = contarRepassesPorGrupo(allRepasses, workflowData);

    res.status(200).json({
      total: allRepasses.length,
      limit: `${limit}`,
      offset: 0,
      totalConteudo,
      filtroAplicado: empreendimento || null,
      filtros: {
        mostrarCancelados: exibirCancelados,
        mostrarDistratos: exibirDistratos,
        mostrarCessoes: exibirCessoes
      },
      empreendimentos,
      repasses: allRepasses,
      statusConfig: workflowData.situacoes,
      grupos: workflowData.grupos,
      contagemSituacoes,
      contagemGrupos
    });
  } catch (error) {
    console.error('Erro ao buscar repasses:', error.message);
    res.status(500).json({ error: 'Erro ao buscar repasses na API externa' });
  }
};

export const fetchRepasseWorkflow = async (req, res) => {
  try {
    const workflowData = await getRepasseWorkflow();
    res.status(200).json(workflowData);
  } catch (error) {
    console.error('Erro ao buscar workflow de repasses:', error.message);
    res.status(500).json({ error: 'Erro ao buscar workflow de repasses na API externa' });
  }
};

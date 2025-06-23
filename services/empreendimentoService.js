// src/services/empreendimentosService.js
import apiCv from '../lib/apiCv.js';

let empreendimentosCache = {
  dados: [],
  timestamp: 0,
  expiracaoMs: 3600000 // 1 hora
};

export const getEmpreendimentos = async () => {
  try {
    const agora = Date.now();
    if (empreendimentosCache.dados.length > 0 && (agora - empreendimentosCache.timestamp) < empreendimentosCache.expiracaoMs) {
      console.log('Retornando dados de empreendimentos do cache');
      return empreendimentosCache.dados;
    }

    const response = await apiCv.get('/v1/cvbot/empreendimentos');
    const dados = response.data;

    const empreendimentos = dados
      .filter(emp => emp.idempreendimento && emp.nome)
      .map(emp => ({
        id: emp.idempreendimento,
        nome: emp.nome
      }))
      .sort((a, b) => a.nome.localeCompare(b.nome));

    empreendimentosCache = {
      dados: empreendimentos,
      timestamp: agora,
      expiracaoMs: 3600000
    };

    return empreendimentos;
  } catch (error) {
    console.error('Erro ao buscar empreendimentos:', error);
    throw error;
  }
};

export const getEmpreendimentoDetalhes = async (id) => {
  try {
    const response = await apiCv.get(`/cvio/empreendimento/${id}`);
    return response.data;
  } catch (error) {
    console.error(`Erro ao buscar detalhes do empreendimento ${id}:`, error);
    throw error;
  }
};

export const getAllBuildings = async () => {
  try {
    const response = await apiCv.get('/cvio/empreendimento');
    return response.data;
  } catch (error) {
    console.error('Erro ao buscar todos os empreendimentos (buildings):', error);
    throw error;
  }
};

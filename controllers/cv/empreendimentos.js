// controllers/cv/empreendimentos.js
import {
  getEmpreendimentos,
  getEmpreendimentoDetalhes,
  getAllBuildings
} from '../../services/empreendimentoService.js';

export const fetchEmpreendimentos = async (req, res) => {
  try {
    const empreendimentos = await getEmpreendimentos();
    res.status(200).json({ empreendimentos });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar empreendimentos na API externa' });
  }
};

export const fetchBuildings = async (req, res) => {
  try {
    const data = await getAllBuildings();
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar empreendimentos na API externa' });
  }
};

export const fetchBuildingById = async (req, res) => {
  const { id } = req.params;
  if (!id) {
    return res.status(400).json({ error: "O parâmetro 'id' é obrigatório." });
  }

  try {
    const data = await getEmpreendimentoDetalhes(id);
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar empreendimento na API externa' });
  }
};

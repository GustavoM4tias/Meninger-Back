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

// helper "ILIKE" em JS: case-insensitive e sem acentos
const norm = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

export const fetchBuildings = async (req, res) => {
  try {
    // exige auth (para pegar role/city)
    if (!req.user) {
      return res.status(401).json({ error: 'Usuário não autenticado.' });
    }

    const isAdmin = req.user.role === 'admin';
    const userCity = req.user.city || '';

    // busca "crua" na API externa
    const data = await getAllBuildings(); // retorna um array

    // admin → retorna tudo sem filtrar
    if (isAdmin) {
      return res.status(200).json(data);
    }

    // não-admin → precisa de cidade no token
    if (!userCity.trim()) {
      return res.status(400).json({ error: 'Cidade do usuário ausente no token.' });
    }

    const target = norm(userCity);

    // filtra por ILIKE %city% no campo "cidade" (com fallback para "city"/"address.city" se algum dia vier diferente)
    const filtered = data.filter((item) => {
      const itemCity =
        item.cidade ??
        item.city ??
        item?.address?.city ??
        '';

      return itemCity && norm(itemCity).includes(target);
    });

    return res.status(200).json(filtered);
  } catch (error) {
    console.error('Erro ao buscar empreendimentos (filtrados):', error);
    return res.status(500).json({ error: 'Erro ao buscar empreendimentos na API externa' });
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

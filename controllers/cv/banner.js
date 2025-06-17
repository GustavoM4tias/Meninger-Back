// src/controllers/cv/banner.js
import apiCv from '../../lib/apiCv.js'; 

// New function for fetching login banners
export const fetchBanners = async (req, res) => {
  try {
    const { data } = await apiCv.get('/v1/cliente/banners/login');
    return res.json(data);
  } catch (error) {
    console.error('Erro ao buscar banners:', error.message);
    if (error.response) {
      const { status, data: errorData } = error.response;
      return res.status(status).json(errorData);
    }
    return res.status(500).json({ error: 'Erro ao buscar banners' });
  }
};
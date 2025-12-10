// controllers/sienge/awardController.js
import {
  createAwardFromNfseFile,
  listAwards,
  updateAward as updateAwardService,
  createAwardLinks,
  getAwardById,
  registerSales as registerSalesService,
} from "../../services/sienge/awardService.js";

export async function uploadNfseAward(req, res, next) {
  try {
    const award = await createAwardFromNfseFile(req.file)

    let links = []
    if (req.body.links) {
      try {
        links = JSON.parse(req.body.links)
      } catch (e) {
        console.warn('links inválido no uploadNfseAward:', e)
      }
    }

    if (Array.isArray(links) && links.length > 0) {
      await createAwardLinks(award.id, links)
    }

    const fullAward = await getAwardById(award.id)

    return res.status(201).json({ award: fullAward })
  } catch (err) {
    next(err)
  }
}

export async function getAwards(req, res, next) {
  try {
    const awards = await listAwards();
    return res.json({ results: awards });
  } catch (err) {
    next(err);
  }
}

export async function updateAward(req, res, next) {
  try {
    const { id } = req.params;
    const award = await updateAwardService(id, req.body);
    return res.json({ award });
  } catch (err) {
    next(err);
  }
}

export async function registerSales(req, res, next) {
  try {
    const { sales } = req.body

    const awards = await registerSalesService(sales)

    return res.status(201).json({
      message: "Clientes registrados na premiação.",
      awards,
    })
  } catch (err) {
    if (err.message === "Envie uma lista de vendas para registrar.") {
      return res.status(400).json({ error: err.message })
    }
    next(err)
  }
}

// controllers/sienge/awardController.js
import {
  createAwardFromNfseFile,
  listAwards,
  updateAward as updateAwardService,
  createAwardLinks,
  getAwardById,
  registerSales as registerSalesService,
  attachNfseToAward as attachNfseToAwardService,
  bulkAttachNfse as bulkAttachNfseService,
  clearNfseFromAwards as clearNfseFromAwardsService,
  deleteAwards as deleteAwardsService,
  deleteAward as deleteAwardService,
} from "../../services/sienge/awardService.js";

function parseIds(raw) {
  if (!raw) return []
  if (Array.isArray(raw)) return raw

  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed
    } catch (err) {
      // ignore
    }
    return raw
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id !== "")
  }
  return []
}

export async function uploadNfseAward(req, res, next) {
  try {
    const award = await createAwardFromNfseFile(req.file, req.user)

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
    const award = await updateAwardService(id, req.body, req.user);
    return res.json({ award });
  } catch (err) {
    next(err);
  }
}

export async function attachNfseToAward(req, res, next) {
  try {
    const { id } = req.params
    const award = await attachNfseToAwardService(id, req.file, req.user)
    return res.json({ award })
  } catch (err) {
    next(err)
  }
}

export async function registerSales(req, res, next) {
  try {
    const { sales } = req.body

    const awards = await registerSalesService(sales, req.user)

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

export async function bulkAttachNfse(req, res, next) {
  try {
    const awardIds = parseIds(req.body.awardIds)
    const sourceAwardId = req.body.sourceAwardId ?? null

    const awards = await bulkAttachNfseService({
      awardIds,
      file: req.file || null,
      sourceAwardId,
    }, req.user)

    return res.json({ awards })
  } catch (err) {
    next(err)
  }
}

export async function clearNfseFromAwards(req, res, next) {
  try {
    const awardIds = parseIds(req.body.awardIds)
    const awards = await clearNfseFromAwardsService(awardIds, req.user)
    return res.json({ awards })
  } catch (err) {
    next(err)
  }
}

export async function deleteAward(req, res, next) {
  try {
    const { id } = req.params
    await deleteAwardService(id, req.user)
    return res.status(204).send()
  } catch (err) {
    next(err)
  }
}

export async function deleteAwards(req, res, next) {
  try {
    const awardIds = parseIds(req.body.awardIds)
    const removedIds = await deleteAwardsService(awardIds, req.user)
    return res.json({ removedIds })
  } catch (err) {
    next(err)
  }
}

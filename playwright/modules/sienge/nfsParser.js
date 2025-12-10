// modules/sienge/nfsParser.js
import { XMLParser } from "fast-xml-parser";

function findValueByKeys(obj, candidates) {
    const lowerCandidates = candidates.map((c) => c.toLowerCase());

    function walk(node) {
        if (node && typeof node === "object") {
            for (const [key, value] of Object.entries(node)) {
                if (lowerCandidates.includes(key.toLowerCase())) {
                    return value;
                }
                const nested = walk(value);
                if (nested !== undefined) return nested;
            }
        }
        return undefined;
    }

    return walk(obj);
}

export function parseNfseXml(xmlString) {
    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "",
    });

    const json = parser.parse(xmlString);

    const issueDate =
        findValueByKeys(json, [
            "DataEmissao",
            "dataEmissao",
            "DataEmissaoRps",
            "dEmi",
        ]) || null;

    const invoiceNumber =
        findValueByKeys(json, [
            "Numero",
            "NumeroNfse",
            "numeroNfse",
            "nrNota",
            "NumeroNota",
        ]) || null;

    const providerName =
        findValueByKeys(json, [
            "RazaoSocial",
            "razaoSocialPrestador",
            "NomePrestador",
            "razaoSocial",
            "Nome",
        ]) || null;

    const providerCnpjRaw =
        findValueByKeys(json, ["Cnpj", "CNPJ", "CpfCnpj", "CpfCNPJ"]) || null;

    const providerCnpj = providerCnpjRaw
        ? String(
            typeof providerCnpjRaw === "object" && providerCnpjRaw.Cnpj
                ? providerCnpjRaw.Cnpj
                : providerCnpjRaw
        ).replace(/\D/g, "")
        : null;

    const customerName =
        findValueByKeys(json, [
            "RazaoSocialTomador",
            "razaoSocialTomador",
            "NomeTomador",
            "Tomador",
            "TomadorServico",
        ]) || null;

    const serviceDescription =
        findValueByKeys(json, [
            "Discriminacao",
            "discriminacao",
            "DescricaoServico",
            "descricaoServico",
            "ServicoPrestado",
        ]) || null;

    const totalAmountRaw =
        findValueByKeys(json, [
            "ValorServicos",
            "valorServicos",
            "ValorLiquidoNfse",
            "valorLiquidoNfse",
            "ValorTotal",
            "vNF",
        ]) || null;

    const totalAmount =
        totalAmountRaw != null
            ? Number(
                String(totalAmountRaw)
                    .replace(".", "")
                    .replace(",", ".")
            ) || null
            : null;

    return {
        issueDate,
        invoiceNumber,
        providerName,
        providerCnpj,
        customerName,
        serviceDescription,
        totalAmount,
        raw: json,
    };
}

// services/checklist/importService.js
// Importa um checklist a partir de um .xlsx no formato dos checklists atuais
// (1 aba = 1 seção; colunas TAREFA/CATEGORIA/STATUS/VALORES/DATAS/RESPONSÁVEL/ANOTAÇÕES).
import XLSX from 'xlsx';
import db from '../../models/sequelize/index.js';
import { loadStatusMap, recomputeProgress, logActivity } from './lib.js';

function norm(s) {
    return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase();
}

// Cabeçalho da planilha -> campo da tarefa.
const COLMAP = {
    'TAREFA': 'title',
    'CATEGORIA': 'category',
    'STATUS': 'status',
    'PRIORIDADE': 'priority',
    'VALORES': 'value', 'VALOR': 'value',
    'DATA DE CONTRATACAO': 'contracted_at', 'DATA CONTRATACAO': 'contracted_at',
    'DATA PARA ENTREGA': 'due_date', 'DATA DE ENTREGA': 'due_date', 'ENTREGA': 'due_date',
    'RESPONSAVEL': 'assignee_label',
    'ANOTACOES': 'description', 'OBSERVACOES': 'description', 'OBS': 'description',
};

function toDateOnly(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
    const s = String(v).trim();
    const br = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (br) {
        const y = br[3].length === 2 ? `20${br[3]}` : br[3];
        return `${y}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`;
    }
    const d = new Date(s);
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

function toNumber(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    // "R$ 1.200,50" -> 1200.50
    const cleaned = String(v).replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
}

export async function importFromExcel({ buffer, fileName, title, userId }) {
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const statusMap = await loadStatusMap();
    const statusByNorm = new Map();
    for (const s of statusMap.values()) statusByNorm.set(norm(s.label), s.id);

    const checklist = await db.Checklist.create({
        title: (title && title.trim()) || (fileName ? fileName.replace(/\.[^.]+$/, '') : 'Checklist importado'),
        kind: 'GENERIC',
        status: 'active',
        key_dates: [],
        owner_user_id: userId || null,
        created_by: userId || null,
        updated_by: userId || null,
    });

    let totalTasks = 0;
    let sectionsCreated = 0;
    let sPos = 0;

    for (const sheetName of wb.SheetNames) {
        const ws = wb.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false });

        // Acha a linha de cabeçalho (contém "TAREFA") e mapeia as colunas.
        let headerIdx = -1;
        const headerCols = {};
        for (let i = 0; i < Math.min(rows.length, 15); i++) {
            const r = rows[i] || [];
            const idx = r.findIndex((c) => norm(c) === 'TAREFA');
            if (idx >= 0) {
                headerIdx = i;
                r.forEach((c, ci) => { const f = COLMAP[norm(c)]; if (f) headerCols[ci] = f; });
                break;
            }
        }
        if (headerIdx < 0) continue; // aba sem cabeçalho reconhecível (ignora)

        sPos += 10;
        sectionsCreated++;
        const section = await db.ChecklistSection.create({
            checklist_id: checklist.id,
            name: (sheetName || `Seção ${sectionsCreated}`).trim(),
            position: sPos,
        });

        let iPos = 0;
        for (let i = headerIdx + 1; i < rows.length; i++) {
            const r = rows[i] || [];
            const rec = {};
            for (const [ci, field] of Object.entries(headerCols)) rec[field] = r[ci];

            const titleVal = String(rec.title ?? '').trim();
            if (!titleVal) continue;

            iPos += 10;
            await db.ChecklistTask.create({
                checklist_id: checklist.id,
                section_id: section.id,
                category: rec.category ? String(rec.category).trim() : null,
                title: titleVal,
                description: rec.description ? String(rec.description).trim() : null,
                status_id: rec.status ? (statusByNorm.get(norm(rec.status)) || null) : null,
                priority: 'MEDIUM',
                value: toNumber(rec.value),
                contracted_at: toDateOnly(rec.contracted_at),
                due_date: toDateOnly(rec.due_date),
                assignee_label: rec.assignee_label ? String(rec.assignee_label).trim() : null,
                position: iPos,
                created_by: userId || null,
            });
            totalTasks++;
        }
    }

    await recomputeProgress(checklist.id);
    await logActivity({ checklistId: checklist.id, userId, action: 'checklist.imported', meta: { file: fileName, tasks: totalTasks } });
    return { id: checklist.id, sections: sectionsCreated, tasks: totalTasks };
}

export default { importFromExcel };

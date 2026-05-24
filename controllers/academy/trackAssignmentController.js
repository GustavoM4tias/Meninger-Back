import trackAssignmentService from '../../services/academy/trackAssignmentService.js';
import xlsx from 'xlsx';
import dayjs from 'dayjs';

const trackAssignmentController = {
    async list(req, res) {
        try {
            const { slug } = req.params;
            return res.json(await trackAssignmentService.list({ trackSlug: slug }));
        } catch (err) {
            console.error('[academy.tracksAdmin.assignments.list]', err);
            return res.status(400).json({ message: err.message || 'Erro ao listar vínculos.' });
        }
    },

    async add(req, res) {
        try {
            const { slug } = req.params;
            return res.status(201).json(await trackAssignmentService.add({ trackSlug: slug, payload: req.body }));
        } catch (err) {
            console.error('[academy.tracksAdmin.assignments.add]', err);
            return res.status(400).json({ message: err.message || 'Erro ao vincular trilha.' });
        }
    },

    async remove(req, res) {
        try {
            const { slug, id } = req.params;
            return res.json(await trackAssignmentService.remove({ trackSlug: slug, id: Number(id) }));
        } catch (err) {
            console.error('[academy.tracksAdmin.assignments.remove]', err);
            return res.status(400).json({ message: err.message || 'Erro ao remover vínculo.' });
        }
    },

    async bulkAdd(req, res) {
        try {
            const { slug } = req.params;
            const { scopeType, scopeValues, required = true, mandatory = false, dueAt = null } = req.body || {};

            return res.status(201).json(
                await trackAssignmentService.bulkAdd({
                    trackSlug: slug,
                    scopeType,
                    scopeValues,
                    required,
                    mandatory,
                    dueAt,
                })
            );
        } catch (err) {
            console.error('[academy.tracksAdmin.assignments.bulkAdd]', err);
            return res.status(400).json({ message: err.message || 'Erro ao vincular em massa.' });
        }
    },

    async adherence(req, res) {
        try {
            const { slug } = req.params;
            return res.json(await trackAssignmentService.adherence({ trackSlug: slug }));
        } catch (err) {
            console.error('[academy.tracksAdmin.assignments.adherence]', err);
            return res.status(400).json({ message: err.message || 'Erro ao carregar aderência.' });
        }
    },

    // S3.2: export Excel da aderência (.xlsx)
    async adherenceXlsx(req, res) {
        try {
            const { slug } = req.params;
            const data = await trackAssignmentService.adherence({ trackSlug: slug });

            const STATUS_LABELS = {
                COMPLETED: 'Concluído',
                IN_PROGRESS: 'Em andamento',
                NOT_STARTED: 'Não iniciado',
                OVERDUE: 'Em atraso',
            };

            const rows = (data.users || []).map(r => {
                const dueDate = r.dueAt ? dayjs(r.dueAt) : null;
                const daysLate = dueDate && r.status !== 'COMPLETED' && dueDate.isBefore(dayjs())
                    ? dayjs().diff(dueDate, 'day')
                    : 0;

                return {
                    'Nome': r.user?.username || '',
                    'E-mail': r.user?.email || '',
                    'Cargo': r.user?.position || '',
                    'Cidade': r.user?.city || '',
                    'Status': STATUS_LABELS[r.status] || r.status,
                    'Progresso (%)': r.progressPercent,
                    'Prazo': dueDate ? dueDate.format('DD/MM/YYYY') : '',
                    'Dias em atraso': daysLate,
                };
            });

            // Cabeçalho resumo
            const summaryRows = [
                ['Relatório de Aderência'],
                [`Trilha: ${slug}`],
                [`Gerado em: ${dayjs().format('DD/MM/YYYY HH:mm')}`],
                [],
                ['Resumo:'],
                ['Total', data.total],
                ['Concluído', data.completed],
                ['Em andamento', data.inProgress],
                ['Não iniciado', data.notStarted],
                ['Em atraso', data.overdue],
                [],
            ];

            const wb = xlsx.utils.book_new();

            // Aba "Resumo" + "Aderência"
            const wsSummary = xlsx.utils.aoa_to_sheet(summaryRows);
            xlsx.utils.book_append_sheet(wb, wsSummary, 'Resumo');

            const wsData = xlsx.utils.json_to_sheet(rows);
            xlsx.utils.book_append_sheet(wb, wsData, 'Aderência');

            // Buffer + headers
            const buffer = xlsx.write(wb, { bookType: 'xlsx', type: 'buffer' });
            const filename = `aderencia_${slug}_${dayjs().format('YYYY-MM-DD')}.xlsx`;

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            return res.end(buffer);
        } catch (err) {
            console.error('[academy.tracksAdmin.assignments.adherenceXlsx]', err);
            return res.status(400).json({ message: err.message || 'Erro ao gerar planilha.' });
        }
    },
};

export default trackAssignmentController;

import fetch from 'node-fetch'; // Certifique-se de ter instalado o node-fetch: npm install node-fetch

// Função para buscar reservas na API externa
export const fetchReservations = async (req, res) => {
    try { 
        const { situacao } = req.query;
 
        if (!situacao) {
            return res.status(400).json({ error: "O parâmetro 'situacao' é obrigatório." });
        }
 
        const url = `https://menin.cvcrm.com.br/api/cvio/reserva?situacao=${situacao}`;

        // Fazer a requisição para a API externa
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                email: 'gustavo.diniz@menin.com.br',
                token: 'e857a8b83b6c7172c224babdb75175b3b8ecd565',
                Accept: 'application/json',
            },
        });

        if (response.ok) {
            const data = await response.json(); 
            res.status(200).json(data);
        } else {
            const errorData = await response.json();
            res.status(response.status).json(errorData);
        }
    } catch (error) {
        console.error('Erro ao buscar reservas:', error.message);
        res.status(500).json({ error: 'Erro ao buscar reservas na API externa' });
    }
};

import fetch from 'node-fetch'; // Certifique-se de ter instalado o node-fetch: npm install node-fetch

// Função para buscar reservas na API externa
export const fetchReservations = async (req, res) => {
    try { 

        const { idempreendimento } = req.query;
 
        if (!idempreendimento) {
            return res.status(400).json({ error: "O parâmetro 'idempreendimento' é obrigatório." });
        }
 
        const url = `https://menin.cvcrm.com.br/api/cvio/reserva?situacao=todas&condicao_completa=true&idempreendimento=${idempreendimento}`;

        // Fazer a requisição para a API externa
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                email: 'gustavo.diniz@menin.com.br',
                token: '2c6a67629efc93cfa16cf77dc8fbbdd92ee500ad',
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

// Função para buscar reservas na API externa
export const fetchReservationsOLD = async (req, res) => {
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
                token: '2c6a67629efc93cfa16cf77dc8fbbdd92ee500ad',
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

// New function for fetching distracts
export const fetchDistracts = async (req, res) => {
    try {
        const url = `https://menin.cvcrm.com.br/api/v1/cv/gestoes-distrato?limit=300`;

        // Make the request to the external API
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                email: 'gustavo.diniz@menin.com.br',
                token: '2c6a67629efc93cfa16cf77dc8fbbdd92ee500ad',
                Accept: 'application/json',
            },
        });

        if (response.ok) {
            const data = await response.json();
        } else {
            const errorData = await response.json();
        }
    } catch (error) {
        console.error('Erro ao buscar distratos:', error);
    }
};

// New function for fetching buildings
export const fetchBuildings = async (req, res) => {
    try {
        const url = `https://menin.cvcrm.com.br/api/cvio/empreendimento`;

        // Make the request to the external API
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                email: 'gustavo.diniz@menin.com.br',
                token: '2c6a67629efc93cfa16cf77dc8fbbdd92ee500ad',
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
        console.error('Erro ao buscar empreendimentos:', error);
        res.status(500).json({ error: 'Erro ao buscar empreendimentos na API externa' });
    }
};
// Nova função para buscar um empreendimento pelo ID
export const fetchBuildingById = async (req, res) => {
    try {
        const { id } = req.params; // Captura o ID do empreendimento na URL

        if (!id) {
            return res.status(400).json({ error: "O parâmetro 'id' é obrigatório." });
        }

        const url = `https://menin.cvcrm.com.br/api/cvio/empreendimento/${id}`;

        // Faz a requisição para a API externa
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                email: 'gustavo.diniz@menin.com.br',
                token: '2c6a67629efc93cfa16cf77dc8fbbdd92ee500ad',
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
        console.error('Erro ao buscar empreendimento pelo ID:', error);
        res.status(500).json({ error: 'Erro ao buscar empreendimento na API externa' });
    }
};

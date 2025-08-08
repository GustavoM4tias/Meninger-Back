// ✅ Permite se o cargo (position) estiver autorizado
export const authorizeByPosition = (allowedPositions = []) => {
    return (req, res, next) => {
        if (req.user.role === 'admin') return next(); // Admin sempre tem acesso

        if (!allowedPositions.includes(req.user.position)) {
            return res.status(403).json({
                success: false,
                error: 'Permissão negada: cargo não autorizado.'
            });
        }

        next();
    };
};

// ✅ Permite se o tipo de usuário (role) estiver autorizado
export const authorizeByRole = (allowedRoles = []) => {
    return (req, res, next) => {
        if (allowedRoles.includes(req.user.role)) return next();

        return res.status(403).json({
            success: false,
            error: 'Permissão negada: tipo de usuário não autorizado.'
        });
    };
};

// ✅ Permite somente se o role e o position forem autorizados ao mesmo tempo
export const authorizeStrict = (allowedRoles = [], allowedPositions = []) => {
    return (req, res, next) => {
        const { role, position } = req.user;

        const roleAllowed = allowedRoles.includes(role);
        const positionAllowed = allowedPositions.includes(position);

        if (!(roleAllowed && positionAllowed)) {
            return res.status(403).json({
                success: false,
                error: 'Acesso negado: perfil sem permissão para esta ação.'
            });
        }

        next();
    };
};

// ✅ Filtro de cidade: usuários só veem sua cidade, admin vê tudo
export const filterByCity = (req, res, next) => {
    if (req.user.role === 'admin') return next(); // Admin vê tudo
    req.cityFilter = req.user.city;
    next();
};

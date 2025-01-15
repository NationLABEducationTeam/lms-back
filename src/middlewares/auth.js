const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');

// Initialize the JWKS client
const client = jwksClient({
    jwksUri: process.env.COGNITO_JWKS_URL,
    cache: true,
    rateLimit: true
});

// Get the signing key
const getSigningKey = (header, callback) => {
    client.getSigningKey(header.kid, (err, key) => {
        if (err) return callback(err);
        const signingKey = key.getPublicKey();
        callback(null, signingKey);
    });
};

// Verify JWT token middleware
const verifyToken = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ message: 'Authorization header missing' });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({ message: 'Token missing' });
    }

    jwt.verify(token, getSigningKey, {
        algorithms: ['RS256']
    }, (err, decoded) => {
        if (err) {
            return res.status(401).json({ message: 'Invalid token' });
        }
        req.user = decoded;
        next();
    });
};

// Role-based access control middleware
const requireRole = (allowedRoles) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ message: 'User not authenticated' });
        }

        const userGroups = req.user['cognito:groups'] || [];
        const hasAllowedRole = allowedRoles.some(role => userGroups.includes(role));

        if (!hasAllowedRole) {
            return res.status(403).json({ message: 'Insufficient permissions' });
        }

        next();
    };
};

module.exports = {
    verifyToken,
    requireRole
}; 
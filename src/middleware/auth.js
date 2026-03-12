const { verifyToken } = require("../auth/auth.js");

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    console.log("[AUTH] Token não fornecido");
    return res.status(401).json({
      error: "Token não fornecido",
    });
  }

  const token = authHeader.split(" ")[1];
  console.log("[AUTH] Verificando token...");
  const decoded = verifyToken(token);

  if (!decoded) {
    console.log("[AUTH] Token inválido");
    return res.status(401).json({
      error: "Token inválido",
    });
  }

  console.log("[AUTH] Token válido, usuário:", decoded);
  req.user = decoded;

  next();
}

module.exports = authMiddleware;
module.exports.authMiddleware = authMiddleware;

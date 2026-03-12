const jwt = require("jsonwebtoken");

const JWT_SECRET = (process.env.JWT_SECRET || "").trim();

function generateToken(payload) {
  if (!JWT_SECRET) {
    throw new Error("JWT_SECRET não configurado no ambiente");
  }

  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: "7d",
  });
}

function verifyToken(token) {
  if (!JWT_SECRET) {
    return null;
  }

  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

module.exports = {
  generateToken,
  verifyToken,
};

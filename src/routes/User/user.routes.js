const express = require("express");
const {
  createUser,
  getUsers,
  getPlatformStats,
  login,
  getNearbyEmployees,
  radius,
  updateProfile,
  getProfessions,
  searchProfessions,
  searchEmployees,
} = require("./repository/User");
const router = express.Router();
const { authMiddleware } = require("../../middleware/auth");
const { verifyToken } = require("../../auth/auth.js");
const pool = require("../../database/db.js");

//ROUTER COMO USER PARA MELHORAR IDENTIFICAÇÃO
const user = router;

user.get("/get", async (req, res) => {
  getUsers(req, res);
});

user.get("/platform-stats", async (req, res) => {
  getPlatformStats(req, res);
});

user.post("/", (req, res) => {
  createUser(req, res);
});

router.get("/me", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Token não fornecido" });
    }

    const token = authHeader.split(" ")[1];
    const decoded = verifyToken(token);

    if (!decoded) {
      return res.status(401).json({ message: "Token inválido" });
    }

    const userId = decoded.id ?? decoded.userId ?? decoded.sub;
    if (!userId) {
      return res.status(401).json({ message: "Token inválido" });
    }

    const [usersColumnsResult, citiesColumnsResult] = await Promise.all([
      pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'users'`,
      ),
      pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'cities'`,
      ),
    ]);

    const usersColumns = new Set(usersColumnsResult.rows.map((r) => r.column_name));
    const citiesColumns = new Set(citiesColumnsResult.rows.map((r) => r.column_name));

    const selectFields = ["u.id", "u.name", "u.email", "u.role"];

    if (usersColumns.has("radius")) selectFields.push("u.radius");
    if (usersColumns.has("has_set_radius")) selectFields.push("u.has_set_radius");
    if (usersColumns.has("profile_color")) selectFields.push("u.profile_color");
    if (usersColumns.has("profession_id")) selectFields.push("u.profession_id");
    if (usersColumns.has("city_id")) selectFields.push("u.city_id");
    if (usersColumns.has("zip_code")) selectFields.push("u.zip_code");
    if (usersColumns.has("neighborhood")) selectFields.push("u.neighborhood");
    if (usersColumns.has("street")) selectFields.push("u.street");
    if (usersColumns.has("number")) selectFields.push("u.number");
    if (usersColumns.has("complement")) selectFields.push("u.complement");
    if (usersColumns.has("reference")) selectFields.push("u.reference");

    if (usersColumns.has("city_id") && citiesColumns.has("name")) {
      selectFields.push("c.name AS city_name");
    }
    if (usersColumns.has("city_id") && citiesColumns.has("state")) {
      selectFields.push("c.state AS city_state");
    }
    if (usersColumns.has("city_id") && citiesColumns.has("zip_code")) {
      selectFields.push("c.zip_code AS city_zip_code");
    }

    const shouldJoinCities = usersColumns.has("city_id");

    const result = await pool.query(
      `SELECT
         ${selectFields.join(",\n         ")}
       FROM users u
       ${shouldJoinCities ? "LEFT JOIN cities c ON c.id = u.city_id" : ""}
       WHERE u.id = $1`,
      [userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Usuário não encontrado" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("ERRO NO /me:", error);
    res.status(500).json({ message: "Erro interno" });
  }
});

router.get("/nearby-employees", authMiddleware, getNearbyEmployees);

user.put("/profile", authMiddleware, updateProfile);

user.put("/radius", authMiddleware, radius);

user.post("/login", login);

router.get("/professions", getProfessions);

router.get("/professions/search", searchProfessions);

router.get("/employees/search", authMiddleware, searchEmployees);

module.exports = user;

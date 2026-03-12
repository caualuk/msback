const express = require("express");
const app = express.Router();
const pool = require("../../../database/db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { generateToken } = require("../../../auth/auth");
const { calculateDistance } = require("../../City/repository/City");

// CRIAR USUÁRIO
async function createUser(req, res) {
  const {
    name,
    email,
    password,
    phone,
    role,
    city_id,
    profession_id,
    zip_code,
    neighborhood,
    street,
    number,
    complement,
    reference,
  } = req.body; // PREENCHENDO OS CAMPOS DO USUÁRIO PELO BODY

  if (!name || !email || !password || !phone || !role || !city_id) {
    return res.status(400).json({ error: "Campos obrigatórios ausentes" });
  }

  if (!zip_code || !neighborhood || !street || !number) {
    return res.status(400).json({
      error: "Endereço incompleto. Informe CEP, bairro, rua e número.",
    });
  }

  try {
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const result = await pool.query(
      `INSERT INTO users 
   (name, email, password, phone, role, city_id, profession_id, zip_code, neighborhood, street, number, complement, reference) 
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
   RETURNING *;`,
      [
        name,
        email,
        hashedPassword,
        phone,
        role,
        city_id,
        profession_id,
        zip_code,
        neighborhood,
        street,
        number,
        complement || null,
        reference || null,
      ],
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({
      error: "Erro ao criar usuário no banco de dados: " + error.message,
    });
  }
}

// LOGIN

async function login(req, res) {
  const { email, password } = req.body;

  try {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [
      email,
    ]);

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: "Email ou senha inválidos",
      });
    }

    const user = result.rows[0];

    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword) {
      return res.status(401).json({
        error: "Email ou senha inválidos",
      });
    }

    const token = generateToken({
      id: user.id,
      email: user.email,
      role: user.role,
    });

    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        hasSetRadius: user.has_set_radius,
      },
      token,
    });
  } catch (error) {
    res.status(500).json({
      error: "Erro no login: " + error.message,
    });
  }
}

//RADIUS
async function radius(req, res) {
  const { radius } = req.body;
  const userId = req.user.id;

  if (!radius || radius <= 0) {
    return res.status(400).json({ error: "Raio inválido " });
  }

  try {
    await pool.query(
      "UPDATE users SET radius = $1, has_set_radius = true WHERE id = $2",
      [radius, userId],
    );

    return res.json({ message: "Radius atualizado com sucesso " });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Erro interno" });
  }
}

// GET USUÁRIOS
async function getUsers(req, res) {
  try {
    const result = await pool.query("SELECT * FROM users");
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: "Erro ao buscar usuários no banco de dados: " + error.message,
    });
  }
}

async function getNearbyEmployees(req, res) {
  try {
    const { raio } = req.query;

    if (!raio) {
      return res.status(400).json({
        error: "Informe o raio em KM na URL",
      });
    }

    const raioKm = parseFloat(raio);

    if (isNaN(raioKm)) {
      return res.status(400).json({
        error: "Raio precisa ser um número válido",
      });
    }

    const userQuery = await pool.query(
      `SELECT u.id, u.name, u.city_id,
              c.name AS city_name,
              c.state,
              COALESCE(c.lat, c.latitude) AS lat,
              COALESCE(c.lon, c.longitude) AS lon
       FROM users u
       JOIN cities c ON u.city_id = c.id
       WHERE u.id = $1`,
      [req.user.id],
    );

    if (userQuery.rows.length === 0) {
      return res.status(400).json({
        error: "Usuário não encontrado",
      });
    }

    const usuario = userQuery.rows[0];

    const userLat = parseFloat(usuario.lat);
    const userLon = parseFloat(usuario.lon);

    // Fallback para cidade-base sem coordenadas: ainda lista funcionários da mesma cidade.
    if (Number.isNaN(userLat) || Number.isNaN(userLon)) {
      const sameCityEmployees = await pool.query(
        `SELECT 
           u.id,
           u.name,
           u.email,
           u.role,
           u.city_id,
           u.profession_id,
           u.phone,
           u.profile_color,
           p.name AS profession,
           c.name AS city
         FROM users u
         LEFT JOIN professions p ON p.id = u.profession_id
         LEFT JOIN cities c ON c.id = u.city_id
         WHERE u.role = 'EMPLOYEE'
           AND u.city_id = $1
           AND u.id != $2`,
        [usuario.city_id, req.user.id],
      );

      return res.json({
        usuario: {
          id: usuario.id,
          name: usuario.name,
          cidade: usuario.city_name,
          estado: usuario.state,
        },
        raio_km: raioKm,
        warning:
          "Cidade do usuário sem coordenadas. Retornando apenas funcionários da mesma cidade.",
        total_funcionarios: sameCityEmployees.rows.length,
        funcionarios: sameCityEmployees.rows,
      });
    }

    const todasCidades = await pool.query(
      `SELECT id, name, state,
              COALESCE(lat, latitude) AS lat,
              COALESCE(lon, longitude) AS lon
       FROM cities`,
    );

    const cidadesNoRaio = todasCidades.rows
      .map((cidade) => {
        const cityLat = parseFloat(cidade.lat);
        const cityLon = parseFloat(cidade.lon);

        if (Number.isNaN(cityLat) || Number.isNaN(cityLon)) {
          return null;
        }

        const distance = calculateDistance(
          userLat,
          userLon,
          cityLat,
          cityLon,
        );

        return {
          id: cidade.id,
          name: cidade.name,
          state: cidade.state,
          distancia: Number(distance.toFixed(2)),
        };
      })
      .filter((cidade) => cidade && cidade.distancia <= raioKm);

    const cidadesIds = cidadesNoRaio.map((c) => c.id);

    //BUSCAR FUNCIONARIOS NAS CIDADES PROXIMAS
    const funcionariosQuery = await pool.query(
      `SELECT 
  u.id,
  u.name,
  u.email,
  u.role,
  u.city_id,
  u.profession_id,
  u.phone,
  u.profile_color,
  p.name AS profession,
  c.name AS city
FROM users u
LEFT JOIN professions p ON p.id = u.profession_id
LEFT JOIN cities c ON c.id = u.city_id
WHERE u.role = 'EMPLOYEE'
AND u.city_id = ANY($1)
AND u.id != $2`,
      [cidadesIds, req.user.id],
    );

    res.json({
      usuario: {
        id: usuario.id,
        name: usuario.name,
        cidade: usuario.city_name,
        estado: usuario.state,
      },
      raio_km: raioKm,
      total_funcionarios: funcionariosQuery.rows.length,
      funcionarios: funcionariosQuery.rows,
    });
  } catch (error) {
    res.status(500).json({
      error: "Erro ao buscar funcionários próximos: " + error.message,
    });
  }
}

//EDITAR USUÁRIO
async function updateProfile(req, res) {
  const { name, profileColor, role, profession_id } = req.body;
  const userId = req.user.id; // vindo do authMiddleware

  try {
    const normalizedRole = String(role || "").toUpperCase();
    const normalizedProfessionId = Number(profession_id);

    if (normalizedRole === "EMPLOYEE") {
      if (!Number.isInteger(normalizedProfessionId) || normalizedProfessionId <= 0) {
        return res.status(400).json({ error: "Profissão é obrigatória para funcionário" });
      }
    }

    await pool.query(
      `
      UPDATE users 
      SET name = $1,
          profile_color = $2,
          role = $3,
          profession_id = $4
      WHERE id = $5
      `,
      [
        name,
        profileColor,
        normalizedRole || role,
        normalizedRole === "EMPLOYEE" ? normalizedProfessionId : null,
        userId,
      ],
    );

    return res.json({ message: "Perfil atualizado com sucesso" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Erro ao atualizar perfil" });
  }
}

// LISTAR TODAS PROFISSÕES
async function getProfessions(req, res) {
  try {
    const result = await pool.query(
      `SELECT id, name 
       FROM professions
       ORDER BY name`,
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: "Erro ao buscar profissões: " + error.message,
    });
  }
}

// AUTOCOMPLETE - PÁGINA DE REGISTER
async function searchProfessions(req, res) {
  const { q } = req.query;

  if (!q) {
    return res.status(400).json({
      error: "Informar termo para busca",
    });
  }

  try {
    const result = await pool.query(
      `
      SELECT id, name
      FROM professions
      WHERE name ILIKE $1
      ORDER BY name
      LIMIT 10
      `,
      [`${q}%`],
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: "Erro ao buscar profissões",
    });
  }
}

async function getClientServices(req, res) {
  const clientId = req.user.id;

  try {
    const result = await pool.query(
      `SELECT *
       FROM services
       WHERE client_id = $1
       ORDER BY created_at DESC`,
      [clientId],
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar serviços" });
  }
}

async function getEmployeeServices(req, res) {
  const employeeId = req.user.id;

  try {
    const result = await pool.query(
      `SELECT *
       FROM services
       WHERE employee_id = $1
       ORDER BY created_at DESC`,
      [employeeId],
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar serviços" });
  }
}

// AUTOCOMPLETE FUNCIONÁRIOS - PÁGINA DE SERVICES (APENAS DENTRO DO RAIO)
async function searchEmployees(req, res) {
  const { q } = req.query;
  const userId = req.user.id; // vindo do authMiddleware

  if (!q) {
    return res.status(400).json({
      error: "Informar termo para busca",
    });
  }

  try {
    // Buscar o usuário cliente com suas coordenadas e raio
    const userQuery = await pool.query(
      `SELECT u.id, u.radius,
              c.name AS city_name,
              c.lat,
              c.lon
       FROM users u
       JOIN cities c ON u.city_id = c.id
       WHERE u.id = $1`,
      [userId],
    );

    if (userQuery.rows.length === 0) {
      return res.status(400).json({
        error: "Usuário não encontrado",
      });
    }

    const usuario = userQuery.rows[0];
    const raioKm = usuario.radius;

    if (!raioKm) {
      return res.status(400).json({
        error: "Usuário não tem raio definido",
      });
    }

    // Buscar todas as cidades para calcular distância
    const todasCidades = await pool.query("SELECT * FROM cities");

    const cidadesNoRaio = todasCidades.rows
      .map((cidade) => {
        const distance = calculateDistance(
          parseFloat(usuario.lat),
          parseFloat(usuario.lon),
          parseFloat(cidade.lat),
          parseFloat(cidade.lon),
        );

        return {
          id: cidade.id,
          distancia: Number(distance.toFixed(2)),
        };
      })
      .filter((cidade) => cidade.distancia <= raioKm);

    const cidadesIds = cidadesNoRaio.map((c) => c.id);

    if (cidadesIds.length === 0) {
      return res.json([]);
    }

    // Buscar funcionários dentro do raio
    const result = await pool.query(
      `
      SELECT 
        u.id,
        u.name,
        p.name AS profession,
        c.name AS city,
        c.state
      FROM users u
      LEFT JOIN professions p ON p.id = u.profession_id
      LEFT JOIN cities c ON c.id = u.city_id
      WHERE u.role = 'EMPLOYEE'
      AND u.city_id = ANY($1)
      AND u.name ILIKE $2
      AND u.id != $3
      ORDER BY u.name
      LIMIT 10
      `,
      [cidadesIds, `%${q}%`, userId],
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: "Erro ao buscar funcionários: " + error.message,
    });
  }
}

module.exports = {
  createUser,
  getUsers,
  login,
  getNearbyEmployees,
  radius,
  updateProfile,
  getProfessions,
  searchProfessions,
  getClientServices,
  getEmployeeServices,
  searchEmployees,
};

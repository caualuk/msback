const express = require("express");
const router = express.Router();

const {
  getCitiesDb,
  getCityByName,
  getCityByZip,
  getCityByExactName,
  createCity,
  getNearbyCities,
  searchCities,
} = require("./repository/City");

// BUSCAR CIDADE (autocomplete)
router.get("/search", searchCities);

// Resolver cidade por CEP
router.get("/by-zip", getCityByZip);

// Resolver cidade por nome exato
router.get("/by-name", getCityByExactName);

// 💾 SALVAR CIDADE
router.post("/post", createCity);

//CIDADES PROXIMAS
router.get("/cidades-proximas", getNearbyCities);

module.exports = router;

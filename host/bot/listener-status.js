"use strict";

const { HOST, PORT } = require("./constants");

const state = { listening: false, error: "", host: HOST, port: PORT };

function status() {
  return {
    listening: state.listening,
    error: state.error,
    host: HOST,
    port: state.listening ? state.port : PORT,
    address: state.listening ? HOST : "",
  };
}

module.exports = { state, status };

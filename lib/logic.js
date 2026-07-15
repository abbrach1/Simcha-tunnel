'use strict';

// Shared logic lives in public/logic.js (UMD) so the browser can use it in
// Firebase mode; this module just re-exports it for the Node runtimes.
module.exports = require('../public/logic.js');

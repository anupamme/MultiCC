'use strict';

const catalog = require('./catalog');
const { createEventHub } = require('./hub');
const { createEventRuleEngine } = require('./engine');
const { mountEventRoutes } = require('./routes');
const rules = require('./rules');

module.exports = { ...catalog, createEventHub, createEventRuleEngine, mountEventRoutes, validateEventRule: rules.validateEventRule };

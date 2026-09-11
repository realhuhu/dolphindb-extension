const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { Signal } = require('@lumino/signaling');

exports.preferences = () => ({
  value: Object.fromEntries(Object.entries(JSON.parse(readFileSync(resolve(__dirname, '../../schema/settings.json'), 'utf8')).properties)
    .map(([key, schema]) => [key, schema.default])),
  changed: new Signal({}),
});

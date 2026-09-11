import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { ISettingRegistry } from '@jupyterlab/settingregistry';
import { Signal } from '@lumino/signaling';
import type { Profile } from '../../frontend/api.ts';
import { DEFAULT_SETTINGS, resolveSettings, SettingsModel, sortConnections } from '../../frontend/settings.ts';

class FakeSettings {
  composite: unknown = {};
  readonly changed = new Signal<this, void>(this);

  update(value: unknown): void {
    this.composite = value;
    this.changed.emit();
  }

  asSettings(): ISettingRegistry.ISettings { return this as unknown as ISettingRegistry.ISettings; }
}

test('all setting ranges and toggles match schema validation and retain legacy overrides', () => {
  const schema = JSON.parse(readFileSync(new URL('../../schema/settings.json', import.meta.url), 'utf8'));
  for (const [group, definition] of Object.entries(schema.properties) as [string, any][]) {
    for (const [key, field] of Object.entries(definition.properties) as [string, any][]) {
      if (field.type === 'boolean') {
        assert.equal((resolveSettings({ [group]: { [key]: false } }) as any)[group][key], false);
      } else if (field.type === 'integer') {
        for (const value of [field.minimum, field.maximum]) {
          assert.equal((resolveSettings({ [group]: { [key]: value } }) as any)[group][key], value, `${group}.${key}`);
        }
        for (const value of [field.minimum - 1, field.maximum + 1, 1.5, '10', true]) {
          assert.equal((resolveSettings({ [group]: { [key]: value } }) as any)[group][key], field.default, `${group}.${key}`);
        }
      }
    }
  }
  const legacy = resolveSettings({ display: { decimals: 3 }, sidebar: { showConnectionDetails: false } });
  assert.equal(legacy.display.decimals, 3);
  assert.equal(legacy.sidebar.showConnectionDetails, false);
  assert.equal(legacy.sidebar.showConnectionAddress, true);
  assert.deepEqual(legacy.dataBrowser, DEFAULT_SETTINGS.dataBrowser);
});

test('numeric precision follows Settings Editor changes and restores actual values', () => {
  const model = new SettingsModel(), registry = new FakeSettings(); model.bind(registry.asSettings());
  let changes = 0;
  model.changed.connect(() => { changes++; });
  for (const decimals of [0, 2, 20, null]) {
    registry.update({ display: { decimals } });
    assert.equal(model.value.display.decimals, decimals);
  }
  assert.equal(changes, 4);
  registry.update({ display: { decimals: 21 } });
  assert.equal(model.value.display.decimals, null);
  for (const decimals of [-1, 1.5, '2']) {
    assert.equal(resolveSettings({ display: { decimals } }).display.decimals, null);
  }
  model.dispose();
});

test('partial overrides keep defaults; invalid values cannot enter a new connection', () => {
  const schema = JSON.parse(readFileSync(new URL('../../schema/settings.json', import.meta.url), 'utf8'));
  const schemaDefaults = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, (value as { default: unknown }).default]));
  assert.deepEqual(DEFAULT_SETTINGS, schemaDefaults);
  const settings = resolveSettings({ connectionDefaults: { username: '', ssl: true }, sidebar: { alwaysShowSearch: true } });
  assert.deepEqual(settings.connectionDefaults, { port: 8848, username: '', timeout: 10, ssl: true });
  assert.deepEqual(settings.sidebar, { ...DEFAULT_SETTINGS.sidebar, alwaysShowSearch: true });
  assert.deepEqual(resolveSettings({ connectionDefaults: { port: 65536, timeout: -1, username: '\n', ssl: 'yes' }, sidebar: { sortOrder: 'unknown' } }), DEFAULT_SETTINGS);
  assert.deepEqual(resolveSettings(null), DEFAULT_SETTINGS);
});

test('registry changes apply live, reset to defaults, and detach when disposed or rebound', () => {
  const model = new SettingsModel();
  const first = new FakeSettings();
  model.bind(first.asSettings());
  let changes = 0;
  model.changed.connect(() => { changes++; });
  first.update({ sidebar: { showConnectionDetails: false } });
  assert.equal(model.value.sidebar.showConnectionDetails, false);
  first.update({ sidebar: { showConnectionDetails: false } });
  assert.equal(changes, 1);
  first.update({});
  assert.deepEqual(model.value, DEFAULT_SETTINGS);
  const second = new FakeSettings();
  model.bind(second.asSettings());
  first.update({ connectionDefaults: { port: 9999 } });
  assert.equal(model.value.connectionDefaults.port, 8848);
  second.update({ connectionDefaults: { port: 9998 } });
  assert.equal(model.value.connectionDefaults.port, 9998);
  model.dispose();
  second.update({});
  assert.equal(model.value.connectionDefaults.port, 9998);
});

test('new forms capture current defaults without changing open forms or retaining secrets', () => {
  const model = new SettingsModel();
  const settings = new FakeSettings();
  model.bind(settings.asSettings());
  const openedForm = model.createDraft();
  settings.update({ connectionDefaults: { port: 9000, timeout: 25, username: 'reader', ssl: true, password: 'ignored-secret', rememberPassword: true } });
  const nextForm = model.createDraft();
  assert.equal(openedForm.port, 8848);
  assert.equal(nextForm.port, 9000);
  assert.equal(nextForm.timeout, 25);
  assert.equal(nextForm.password, '');
  assert.equal(nextForm.rememberPassword, false);
  nextForm.port = 9001;
  assert.equal(model.createDraft().port, 9000);
  model.dispose();
});

test('sidebar sorting leaves saved order intact and handles numeric names and shared hosts', () => {
  const profiles = [
    { id: 'a', name: 'Node 10', host: 'db.example.com', port: 9000 },
    { id: 'b', name: 'Node 2', host: 'db.example.com', port: 8848 },
    { id: 'c', name: 'Node 1', host: 'a.example.com', port: 9000 },
  ] as Profile[];
  assert.deepEqual(sortConnections(profiles, 'saved').map(p => p.id), ['a', 'b', 'c']);
  assert.deepEqual(sortConnections(profiles, 'name').map(p => p.id), ['c', 'b', 'a']);
  assert.deepEqual(sortConnections(profiles, 'host').map(p => p.id), ['c', 'b', 'a']);
  assert.deepEqual(profiles.map(p => p.id), ['a', 'b', 'c']);
});

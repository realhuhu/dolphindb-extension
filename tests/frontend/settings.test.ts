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

test('partial overrides keep defaults; invalid values cannot enter a new connection', () => {
  const schema = JSON.parse(readFileSync(new URL('../../schema/settings.json', import.meta.url), 'utf8'));
  const schemaDefaults = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, (value as { default: unknown }).default]));
  assert.deepEqual(DEFAULT_SETTINGS, schemaDefaults);
  const settings = resolveSettings({ connectionDefaults: { username: '', ssl: true }, sidebar: { alwaysShowSearch: true } });
  assert.deepEqual(settings.connectionDefaults, { port: 8848, username: '', timeout: 10, ssl: true });
  assert.deepEqual(settings.sidebar, { sortOrder: 'saved', showConnectionDetails: true, alwaysShowSearch: true });
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

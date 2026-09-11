import * as React from 'react';
import { Signal } from '@lumino/signaling';
import { DEFAULT_SETTINGS, type ExtensionSettings, type SettingsModel } from '../settings';

const changes = new Signal<object, void>({});
let preferences: SettingsModel | null = null;
export function bindDisplaySettings(settings: SettingsModel): void {
  if (preferences === settings) { return; }
  preferences?.changed.disconnect(changed);
  preferences = settings; settings.changed.connect(changed); changed();
}
function changed(): void { changes.emit(); }
export function getPreferences(): ExtensionSettings { return preferences?.value ?? DEFAULT_SETTINGS; }
export function usePreferences(): ExtensionSettings {
  const [, render] = React.useState(0);
  React.useEffect(() => { const update = () => render(n => n + 1); changes.connect(update); return () => { changes.disconnect(update); }; }, []);
  return getPreferences();
}
export function useDecimals(): number | null { return usePreferences().display.decimals; }

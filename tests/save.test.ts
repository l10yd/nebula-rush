import assert from 'node:assert/strict';
import test from 'node:test';

import { SaveSystem, defaultSave } from '../src/core/SaveSystem.ts';
import { ProgressStore } from '../src/core/Stores.ts';
import { STORAGE_KEY } from '../src/data/config.ts';
import type { SafeStorage } from '../src/core/Platform.ts';

/**
 * The save file is the one piece of state a player can bring from a broken version of the game,
 * a different resolution, or hand-editing. Nothing it yields may be able to crash a run.
 */

class FakeStorage {
  private readonly map = new Map<string, string>();
  writeCount = 0;

  constructor(private readonly refuse = false) {}

  read(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  write(key: string, value: string): boolean {
    this.writeCount++;
    if (this.refuse) return false;
    this.map.set(key, value);
    return true;
  }

  remove(key: string): void {
    this.map.delete(key);
  }

  as(): SafeStorage {
    return this as unknown as SafeStorage;
  }
}

function raw(storage: FakeStorage): string | null {
  return storage.read(STORAGE_KEY);
}

test('an empty store yields complete defaults', () => {
  const save = new SaveSystem(new FakeStorage().as());
  assert.equal(save.data.version, defaultSave().version);
  assert.ok(save.progress.unlockedShips.includes('vireo'));
  assert.ok(save.settings.keybinds.boost.length > 0);
  assert.equal(save.settings.locale, 'en');
});

test('garbage in storage does not throw and is quarantined', () => {
  const storage = new FakeStorage();
  storage.write(STORAGE_KEY, '<html>not json</html>');
  const save = new SaveSystem(storage.as());
  assert.equal(save.progress.credits, 0);
  assert.deepEqual(save.progress.unlockedShips, ['vireo']);
  assert.equal(raw(storage), null, 'the unreadable payload must not stay live');
  assert.ok(storage.read(`${STORAGE_KEY}.corrupt`), 'bad payload should be kept for diagnosis');
});

test('hostile values are clamped instead of trusted', () => {
  const storage = new FakeStorage();
  const daily: Record<string, unknown> = {};
  for (let i = 0; i < 400; i++) daily[`day${i}`] = { score: -10, timeSec: 9e9 };
  storage.write(
    STORAGE_KEY,
    JSON.stringify({
      version: 'one',
      settings: {
        locale: 'xx',
        quality: 'ultra_ludicrous',
        uiScale: 999,
        fovBias: -1000,
        masterVolume: -3,
        keybinds: { boost: 'Space', left: [1, 2, 3, 'x'.repeat(90)], pause: [] },
      },
      progress: {
        credits: -500,
        selectedShip: 'not_a_ship',
        unlockedShips: ['not_a_ship', 'vireo'],
        ownedCosmetics: 'wing_lights',
        bestScore: Number.NaN,
        bestTimeSec: Number.POSITIVE_INFINITY,
        daily,
      },
    }),
  );
  const save = new SaveSystem(storage.as());
  const { settings, progress } = save.data;
  assert.equal(settings.locale, 'en');
  assert.ok(['ultra', 'high', 'medium', 'low'].includes(settings.quality));
  assert.ok(settings.uiScale <= 1.55 && settings.uiScale >= 0.8);
  assert.ok(settings.fovBias >= -8);
  assert.equal(settings.masterVolume, 0);
  assert.ok(settings.keybinds.pause.length > 0, 'pause must stay bound');
  assert.ok(Array.isArray(settings.keybinds.left) && settings.keybinds.left.length > 0, 'left must stay bound');
  assert.equal(progress.credits, 0);
  assert.equal(progress.selectedShip, 'vireo');
  assert.ok(Number.isFinite(progress.bestScore));
  assert.ok(progress.bestTimeSec <= 3600);
  assert.ok(Object.keys(progress.daily).length <= 60);
  assert.deepEqual(progress.ownedCosmetics, []);
});

test('purchased cosmetics survive a reload', () => {
  const storage = new FakeStorage();
  const first = new SaveSystem(storage.as());
  const progress = new ProgressStore(first);
  for (const id of ['wing_lights', 'hud_frame', 'trail_sparkle', 'collapse_trail']) {
    assert.equal(progress.unlock('cosmetic', id), true, `unlock ${id}`);
  }
  first.save(true);
  const second = new SaveSystem(storage.as());
  const reloaded = new ProgressStore(second);
  for (const id of ['wing_lights', 'hud_frame', 'trail_sparkle', 'collapse_trail']) {
    assert.ok(reloaded.hasCosmetic(id), `${id} persisted`);
  }
});

test('a storage that refuses writes still keeps the session', () => {
  const storage = new FakeStorage(true);
  const save = new SaveSystem(storage.as());
  save.data.progress.credits = 500;
  assert.doesNotThrow(() => save.save(true));
  assert.equal(save.data.progress.credits, 500);
  assert.equal(raw(storage), null, 'nothing should have been persisted');
});

test('a partial save from an older build gains missing fields', () => {
  const storage = new FakeStorage();
  storage.write(STORAGE_KEY, JSON.stringify({ version: 1, progress: { credits: 42 } }));
  const save = new SaveSystem(storage.as());
  assert.equal(save.progress.credits, 42);
  assert.equal(save.data.version, defaultSave().version);
  assert.ok(save.settings.keybinds.drift.length > 0);
  assert.ok(Array.isArray(save.progress.seenTutorialTips));
});

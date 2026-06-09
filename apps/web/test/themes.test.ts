/**
 * Theme registry spec (ADR-0044) — install-free tier: imports only
 * `src/theme/themes.ts`, which is dependency- and DOM-free by design.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coerceThemeId,
  DEFAULT_THEME,
  THEME_BY_ID,
  THEME_STORAGE_KEY,
  THEMES,
} from "../src/theme/themes.ts";

test("registry: ids are unique and THEME_BY_ID covers them all", () => {
  const ids = THEMES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const t of THEMES) assert.equal(THEME_BY_ID.get(t.id), t);
});

test("registry: every theme carries the fields CSS cannot provide", () => {
  for (const t of THEMES) {
    assert.ok(t.label.length > 0, `${t.id} label`);
    assert.match(t.themeColor, /^#[0-9a-f]{6}$/i, `${t.id} themeColor`);
    assert.ok(t.grid.fine.length > 0, `${t.id} grid.fine`);
    assert.ok(t.grid.coarse.length > 0, `${t.id} grid.coarse`);
    assert.ok(
      t.colorScheme === "light" || t.colorScheme === "dark",
      `${t.id} colorScheme`,
    );
  }
});

test("default theme is registered", () => {
  assert.ok(THEME_BY_ID.has(DEFAULT_THEME));
});

test("coerceThemeId: passes known ids through, defaults everything else", () => {
  for (const t of THEMES) assert.equal(coerceThemeId(t.id), t.id);
  assert.equal(coerceThemeId("mayhem"), DEFAULT_THEME);
  assert.equal(coerceThemeId(undefined), DEFAULT_THEME);
  assert.equal(coerceThemeId(null), DEFAULT_THEME);
  assert.equal(coerceThemeId(42), DEFAULT_THEME);
});

test("storage key is stable (bootstrap script in index.html duplicates it)", () => {
  assert.equal(THEME_STORAGE_KEY, "ga.theme");
});

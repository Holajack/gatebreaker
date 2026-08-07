// The GameMode contract.
//
// Game.update() no longer knows what a dungeon frame looks like. It clamps dt,
// applies hit-stop and level-up dilation, then hands the frame to whichever
// mode is mounted. That is the entire seam: modes own per-frame simulation and
// the camera, Game keeps ownership of the renderer, the glow pass and the
// quality governor.
//
// Every method here is a no-op so a half-written mode still runs rather than
// throwing inside the frame loop.

export class GameMode {
  constructor(game) {
    this.game = game;
  }

  /** Mount. Build the level, place the player, set the frame target. */
  enter(_payload = {}) {}

  /** Unmount. Tear down anything enter() built. */
  exit() {}

  /**
   * One simulation step. `dt` has ALREADY been time-scaled by hit-stop and
   * level-up dilation; `rawDt` is the unscaled frame time for anything that
   * must run on wall-clock.
   */
  update(_dt, _rawDt) {}

  /**
   * Runs every frame regardless of pause state, for atmosphere that should not
   * freeze behind a menu (sky animation, portal shimmer).
   */
  updateAlways(_dt) {}

  /** Move the camera. Called with the unscaled dt. */
  updateCamera(_dt) {}

  /** Push an entity out of this mode's solids. */
  resolveFor(_entity) {}

  get targetFps() { return 60; }

  get name() { return 'mode'; }
}

// --------------------------------------------------------------- registry

const _factories = new Map();

export const MODE_NAMES = ['city', 'dungeon'];

export function registerMode(name, factory) {
  if (typeof factory !== 'function') throw new Error(`registerMode(${name}): factory must be a function`);
  _factories.set(name, factory);
}

export function createMode(name, game) {
  const factory = _factories.get(name);
  if (!factory) throw new Error(`createMode: no mode registered as '${name}'`);
  return factory(game);
}

export function modeRegistered(name) { return _factories.has(name); }

export default GameMode;

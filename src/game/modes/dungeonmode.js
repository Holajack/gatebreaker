import { GameMode, registerMode } from './mode.js';
import { FLAT_GROUND } from '../physics.js';

/**
 * The gate run, unchanged.
 *
 * This mode owns no simulation code of its own on purpose. Every frame it
 * calls straight back into the Game methods that already existed, so the
 * combat, spawn, damage, XP, projectile and pickup code that shipped is byte
 * for byte the code that runs. If a gate plays differently after this refactor,
 * that is a bug in the extraction and not a design change.
 */
export class DungeonMode extends GameMode {
  constructor(game) {
    super(game);
    this.gateIndex = 0;
    this.rank = 'E';
  }

  get name() { return 'dungeon'; }

  get targetFps() { return 60; }

  /** The biome hazard for this gate. Nothing rolls one yet — biomes.js is a later step. */
  get hazard() { return null; }

  enter({ gateIndex = 0, rank = null } = {}) {
    const g = this.game;
    this.gateIndex = gateIndex;
    this.rank = rank || g.gate?.rank || 'E';

    // A gate is the one place that wants every frame the panel can give.
    g.frameClock?.setTarget(60);
    g.quality?.setTargetFps(60);

    // The arena is flat and its collision is World.resolve — the same
    // environment the body was constructed with. _beginGate builds the world
    // (and therefore packs the obstacle field), so bind the field AFTER it:
    // setEnvironment always assigns the 4th arg, so binding first would be
    // overwritten and binding a not-yet-built field would bind an empty one.
    g.player.body.setEnvironment(FLAT_GROUND, g._arenaResolve);

    g._beginGate(gateIndex);

    // Substepped anti-tunnelling + wall-slide against the arena's pillars and
    // scatter rocks. Without this the player walks straight through them.
    g.player.body.setObstacles(g.world.obstacleField);
  }

  exit() {
    const g = this.game;
    g.clearEntities();
    g.world.clear();
    g.audio.music(false);
    g.ui.showHud(false);
    g.state = 'idle';
  }

  // Sky, drifting shards and the arena wall keep breathing behind a pause,
  // exactly as they did when this call sat unconditionally in Game.update.
  updateAlways(dt) {
    this.game.world.update(dt);
  }

  update(dt) {
    this.game._updateDungeonFrame(dt);
  }

  updateCamera(dt) {
    this.game._updateCamera(dt);
  }

  resolveFor(entity) {
    this.game.world.resolve(entity.pos, entity.radius, entity.vel);
  }
}

registerMode('dungeon', (game) => new DungeonMode(game));

export default DungeonMode;

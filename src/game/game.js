import * as THREE from 'three';
import { World, mulberry32 } from './world.js';
import { Effects } from './effects.js';
import {
  makeHumanoid, makeHealthBar, setHealthBar, animateRig, makeGroundRing, disposeObject3D,
  setCharacterQuality,
} from './entities.js';
import { makeAgent, steerAgent, separate, noteAttack } from './enemyai.js';
import {
  GATES, ENEMY_TYPES, BOSSES, SKILLS, derive, scaleEnemy, rankOf,
} from './config.js';
import {
  grantXp, shadowFieldCapacity, extractionChance,
  MAX_EXTRACT_ATTEMPTS, CORPSE_WINDOW,
} from './progression.js';
import {
  autoDeploy, deployedRecords, addShadow, makeShadow, releaseWeakest,
  shadowCombat, rosterSummary,
} from './shadows.js';
import {
  rollDrop, equipWeapon, currentWeapon, setModelSource,
  serializeWeapon, deserializeWeapon, starterWeapon, buildWeaponMesh, rarityColor,
} from './weapons.js';
import { Glow, GLOW_LAYER } from '../render/glow.js';
import { Quality } from '../core/quality.js';
import { attachBody, applyKnockback, FLAT_GROUND } from './physics.js';

// How hard a corpse resists extraction. progression.extractionChance takes this
// as its tierWeight. Provisional home: difficulty.js owns enemy classification
// once step 11 lands, and this table moves there wholesale.
const TIER_WEIGHT = { brute: 'elite', lancer: 'elite', howler: 'elite' };

// How many spare weapons the save carries. Bounded because the whole profile
// lives in one localStorage string.
const STASH_LIMIT = 12;
// Chance a trash kill leaves a weapon behind. Bosses always drop one.
const WEAPON_DROP_CHANCE = 0.06;
const tierWeightOf = (e) => (e.isBoss ? 'boss' : TIER_WEIGHT[e.key] || 'trash');

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();

// Reused steering context; steerAgent never retains it.
const _steerCtx = {
  navGrid: null, targetPos: null, selfPos: null,
  distance: 0, losBlocked: false, aggression: 1, dt: 0,
};

export class Game {
  constructor({ canvas, input, audio, ui, saveData, onSave }) {
    this.canvas = canvas;
    this.input = input;
    this.audio = audio;
    this.ui = ui;
    this.save = saveData;
    this.onSave = onSave;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      // Rendering direct to the default framebuffer means MSAA resolves in tile
      // memory on mobile GPUs, which is nearly free — so take it.
      antialias: true,
      alpha: false,      // opaque canvas -> WebView's fast composite path
      stencil: false,    // unused; saves a buffer and its per-tile traffic
      depth: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // With image-based lighting online, 1.45 clipped. The env map now supplies
    // the indirect light this was compensating for.
    this.renderer.toneMappingExposure = 1.25;

    this.scene = new THREE.Scene();
    // near 1.0, not 0.1: the camera sits ~15.6 units out and nothing is ever
    // inside the first metre, so a 4000:1 far/near ratio spent most of the
    // depth buffer's precision on empty space and z-fought the arena props.
    this.camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 1.0, 400);
    this.camOffset = new THREE.Vector3(0, 11, 11);
    this.camLook = new THREE.Vector3();
    this.camPos = new THREE.Vector3();

    this.world = new World(this.scene, this.renderer, this.camera);
    this.fx = new Effects(this.scene, this.camera, this.renderer);
    this.glow = new Glow(this.renderer, { scale: 0.25, strength: 1.35, spread: 1.1 });
    this.quality = new Quality({ onChange: (t) => this._applyQuality(t) });
    this._applyQuality(this.quality.current);

    // A backgrounded WebView can lose the GL context outright. Without
    // preventDefault it never restores at all.
    this._lostContext = false;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this._lostContext = true;
      this.pause(true);
    });
    // ...and without this half, restoring leaves a dead canvas: three re-inits
    // its own GL state but every buffer and render target the game uploaded is
    // gone. Android WebViews drop the context on backgrounding routinely, so
    // the old one-sided handler meant a phone call froze the game permanently.
    canvas.addEventListener('webglcontextrestored', () => {
      this._restoreContext();
    });

    this.enemies = [];
    this.shadows = [];
    this.projectiles = [];
    this.corpses = [];
    this.pickups = [];

    this.state = 'idle'; // idle | playing | paused | over
    this.time = 0;

    this.flash = document.createElement('div');
    this.flash.id = 'flash';
    document.body.appendChild(this.flash);

    this._buildPlayer();
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    // Pull the camera back a little on tall phone screens so more arena is visible.
    const tall = h / w > 1.7;
    this.camera.fov = tall ? 64 : 58;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    const dpr = Math.min(window.devicePixelRatio, this.quality?.current.pixelRatio ?? 2);
    this.renderer.setPixelRatio(dpr);
    this.glow?.setSize(w, h, dpr);
  }

  _applyQuality(t) {
    // The skinned-character budget has to follow the RUNTIME tier, not the tier
    // guessed once at import. A device that gets stepped down mid-run otherwise
    // keeps skinning more characters than it can afford.
    setCharacterQuality(t);
    const dpr = Math.min(window.devicePixelRatio, t.pixelRatio);
    this.renderer.setPixelRatio(dpr);
    this.glow.setSize(window.innerWidth, window.innerHeight, dpr);
    this.glow.enabled = t.bloom;
    this.renderer.shadowMap.enabled = t.shadows;
    const key = this.world?.key;
    if (key) {
      key.castShadow = t.shadows;
      if (t.shadows && key.shadow.mapSize.x !== t.shadowMapSize) {
        key.shadow.mapSize.set(t.shadowMapSize, t.shadowMapSize);
        // three only reallocates the depth map when it is null, so changing
        // mapSize alone silently does nothing.
        key.shadow.map?.dispose();
        key.shadow.map = null;
        key.shadow.normalBias = (14 * 2 / t.shadowMapSize) * 1.4;
      }
    }
    this.fx?.setBudget(Math.round(420 * t.particleScale));
  }

  _restoreContext() {
    // Re-push everything that lives outside three's own state tracking, then
    // rebuild the arena — its geometry was uploaded to a context that no longer
    // exists. The seed is kept, so the player lands in the same rift they left.
    this.renderer.shadowMap.needsUpdate = true;
    this._applyQuality(this.quality.current);
    this.resize();
    if (this.gate) this.world.build(this.gate, this.seed);
    // Only auto-resume the pause WE forced. A player who paused deliberately
    // and then took a phone call should still come back to the pause screen.
    if (this._lostContext) {
      this._lostContext = false;
      this.pause(false);
    }
  }

  // ---------------------------------------------------------------- player
  _buildPlayer() {
    // `weapon: 'none'` on purpose: the hardcoded blade makeHumanoid used to
    // build is now supplied by weapons.js, which is what lets the player hold
    // a rolled drop (and, once the item pack has loaded, a real model).
    const mesh = makeHumanoid({
      color: 0x8fa2ff, glow: 0xffc24b, accent: 0x161c3c,
      weapon: 'none', cloak: true, scale: 1,
    });
    this.playerRing = makeGroundRing(0xffc24b, 1.0, 0.8);
    mesh.add(this.playerRing);
    this.scene.add(mesh);

    this.player = {
      mesh,
      pos: new THREE.Vector3(0, 0, 0),
      vel: new THREE.Vector3(),
      yaw: 0,
      radius: 0.6,
      hp: 100, mp: 50,
      attackCd: 0, comboIndex: 0, comboTimer: 0,
      swing: 0, swingHitApplied: false,
      dashTimer: 0, invuln: 0, hurt: 0,
      cds: { attack: 0, dash: 0, slash: 0, nova: 0, summon: 0 },
      alive: true,
      kills: 0,
    };
    this.refreshDerived(true);

    // Bound once: physics calls this every frame and an inline arrow here would
    // allocate a closure per entity per frame.
    this._arenaResolve = (pos, radius, vel) => this.world.resolve(pos, radius, vel);
    attachBody(this.player, { radius: 0.6, maxSpeed: this.derived.speed });
    this.player.body.setEnvironment(FLAT_GROUND, this._arenaResolve);

    this._restoreLoadout();
  }

  // ------------------------------------------------------------- loadout
  //
  // save.weapon and save.stash store (base, rarity, seed, level) per weapon,
  // not a snapshot of every rolled number, so re-tuning the tables later
  // re-derives everyone's gear instead of leaving stale statlines in saves.

  _restoreLoadout() {
    this.weapon = deserializeWeapon(this.save.weapon) || starterWeapon();
    this.stash = (Array.isArray(this.save.stash) ? this.save.stash : [])
      .map((d) => deserializeWeapon(d))
      .filter(Boolean)
      .slice(0, STASH_LIMIT);
    equipWeapon(this.player.mesh, this.weapon);
  }

  _persistLoadout() {
    this.save.weapon = serializeWeapon(this.weapon);
    this.save.stash = this.stash.map((w) => serializeWeapon(w)).filter(Boolean);
    this.onSave();
  }

  /**
   * Point weapon construction at the loaded item pack and rebuild whatever is
   * currently in hand. Called from main.js once loadItemModels resolves TRUE;
   * never called when the GLB is missing, so the procedural weapons stay.
   */
  useItemModels(getMesh) {
    setModelSource(getMesh);
    if (this.player?.mesh && this.weapon) equipWeapon(this.player.mesh, this.weapon);
  }

  /** Equip `w`, sending whatever was held to the stash. */
  equip(w) {
    if (!w) return;
    const old = currentWeapon(this.player.mesh) || this.weapon;
    if (old && old !== w) {
      this.stash.unshift(old);
      if (this.stash.length > STASH_LIMIT) this.stash.length = STASH_LIMIT;
    }
    this.weapon = w;
    equipWeapon(this.player.mesh, w);
    this._persistLoadout();
  }

  /** Shadows allowed on the field at once, clamped by the live quality tier. */
  fieldCapacity() {
    return shadowFieldCapacity(this.save, this.quality.current);
  }

  refreshDerived(fill = false) {
    const prevMaxHp = this.derived?.maxHp ?? 0;
    const prevMaxMp = this.derived?.maxMp ?? 0;
    this.derived = derive(this.save);
    if (fill) {
      this.player.hp = this.derived.maxHp;
      this.player.mp = this.derived.maxMp;
      return;
    }
    // Credit any increase in the maximum. Spending a Vitality point used to
    // raise maxHp while leaving hp alone, so investing in health visibly
    // *shrank* your health bar.
    this.player.hp = Math.min(this.derived.maxHp, this.player.hp + Math.max(0, this.derived.maxHp - prevMaxHp));
    this.player.mp = Math.min(this.derived.maxMp, this.player.mp + Math.max(0, this.derived.maxMp - prevMaxMp));
  }

  // ------------------------------------------------------------- gate flow
  startGate(index) {
    const gate = GATES[index];
    this.gateIndex = index;
    this.gate = gate;
    this.seed = (index + 1) * 7919 + Math.floor(Math.random() * 100000);
    this.rnd = mulberry32(this.seed);

    this.clearEntities();
    this.world.build(gate, this.seed);

    this.player.pos.set(0, 0, 0);
    this.player.vel.set(0, 0, 0);
    this.player.body.reset(0, 0, 0);
    this.player.yaw = 0;
    this.player.alive = true;
    this.player.kills = 0;
    this.player.invuln = 1.2;
    this.player.hurt = 0;
    this.player.swing = 0;
    Object.keys(this.player.cds).forEach((k) => { this.player.cds[k] = 0; });
    this.refreshDerived(true);

    this.spawned = 0;
    this.killed = 0;
    this.bossActive = false;
    this.boss = null;
    this.runTime = 0;
    this.xpEarned = 0;
    this.spawnTimer = 0;
    this.levelsGained = 0;
    this.pointsGained = 0;
    this.levelUpDilation = 0;

    // Carry the deployed roster into the new rift. The field cap is a draw-call
    // budget, so the quality tier gets the final word on how many come along.
    const cap = this.fieldCapacity();
    autoDeploy(this.save, cap);
    for (const rec of deployedRecords(this.save)) {
      this._spawnShadow(this.world.randomSpawn(this.rnd, this.player.pos, 4), true, rec);
    }

    this.state = 'playing';
    this.audio.music(true);
    this.ui.showHud(true);
    this.ui.toast(`${gate.rank}-GRADE RIFT — ${gate.name}`, 'gold');
    this._spawnWave();
  }

  // `dispose` is only ever turned off when a caller intends to re-parent the
  // meshes; scene.remove alone orphaned every geometry and material an entity
  // owned, which is what killed long S-rank runs on Android.
  clearEntities({ dispose = true } = {}) {
    [...this.enemies, ...this.shadows, ...this.projectiles, ...this.corpses, ...this.pickups].forEach((e) => {
      if (e.mesh) { this.scene.remove(e.mesh); if (dispose) disposeObject3D(e.mesh); }
      if (e.bar) { this.scene.remove(e.bar); if (dispose) disposeObject3D(e.bar); }
    });
    this.enemies.length = 0;
    this.shadows.length = 0;
    this.projectiles.length = 0;
    this.corpses.length = 0;
    this.pickups.length = 0;
  }

  _spawnWave() {
    const gate = this.gate;
    const remaining = gate.enemies - this.spawned;
    if (remaining <= 0) return;
    const n = Math.min(gate.waveSize, remaining);
    for (let i = 0; i < n; i++) this._spawnEnemy();
  }

  _spawnEnemy() {
    const gate = this.gate;
    const roll = this.rnd();
    let key = 'grunt';
    // Deeper gates skew toward the nastier archetypes.
    const tier = this.gateIndex / (GATES.length - 1);
    if (roll > 0.85 - tier * 0.15) key = 'caster';
    else if (roll > 0.68 - tier * 0.12) key = 'brute';
    else if (roll > 0.44 - tier * 0.14) key = 'stalker';

    const base = ENEMY_TYPES[key];
    const level = gate.enemyLevel + Math.floor(this.rnd() * 3);
    const s = scaleEnemy(base, level);
    const pos = this.world.randomSpawn(this.rnd, this.player.pos, 12);

    const weapon = key === 'caster' ? 'staff' : key === 'stalker' ? 'claw' : 'sword';
    const mesh = makeHumanoid({
      color: base.color, glow: base.glow, accent: 0x14172a,
      weapon, scale: base.scale, cloak: key === 'caster',
      // The skinned-character picker cannot tell a lancer from a howler by the
      // weapon alone — both carry a plain sword — so name the archetype and the
      // rank outright. Both are advisory; makeHumanoid infers them otherwise.
      archetype: key, rank: this.gate.rank ?? 'E',
    });
    mesh.add(makeGroundRing(base.glow, 0.85 * base.scale, 0.5));
    mesh.position.copy(pos);
    // Rise-from-the-floor spawn: cheap, and it reads as a rift materialization.
    mesh.position.y = -3;
    this.scene.add(mesh);

    const bar = makeHealthBar(1.1 * base.scale, base.glow);
    this.scene.add(bar);

    this.fx.burst(pos.clone().setY(0.4), 14, base.glow, { speed: 5, up: 4, life: 0.6 });
    this.fx.ring(pos, base.glow, 3, 0.5);

    this.enemies.push({
      key, base, level, mesh, bar,
      pos: pos.clone(),
      vel: new THREE.Vector3(),
      yaw: 0,
      hp: s.hp, maxHp: s.hp, atk: s.atk, xp: s.xp,
      radius: 0.55 * base.scale,
      speed: base.speed,
      attackCd: 0.8 + this.rnd() * 1.2,
      telegraph: 0,
      swing: 0,
      hurt: 0,
      stagger: 0,
      spawning: 0.55,
      lungeCd: 0,
      isBoss: false,
    });
    const spawned = this.enemies[this.enemies.length - 1];
    spawned.agent = makeAgent(spawned, base.ai);
    this.spawned++;
  }

  _spawnBoss() {
    const b = BOSSES[this.gate.boss];
    const pos = new THREE.Vector3(0, 0, -this.world.radius * 0.55);
    const mesh = makeHumanoid({
      color: b.color, glow: b.glow, accent: 0x0d0f1c,
      weapon: 'sword', scale: b.scale, cloak: true,
      archetype: 'boss', rank: this.gate.rank ?? 'E',
    });
    mesh.add(makeGroundRing(b.glow, 1.6, 0.6));
    mesh.position.copy(pos);
    mesh.position.y = -6;
    this.scene.add(mesh);

    const bar = makeHealthBar(2.6, b.glow);
    this.scene.add(bar);

    const scaled = Math.floor(b.hp * (1 + (this.save.level - this.gate.reqLevel) * 0.04));
    this.boss = {
      // GATES carries an explicit bossLevel now — roughly a full rank above the
      // gate's trash, which the old enemyLevel+5 only approximated at E rank.
      key: 'boss', base: b, level: this.gate.bossLevel, mesh, bar,
      pos: pos.clone(), vel: new THREE.Vector3(), yaw: 0,
      hp: scaled, maxHp: scaled, atk: b.atk,
      xp: Math.floor(b.xp * (1 + Math.max(0, this.save.level - this.gate.reqLevel) * 0.04)),
      radius: 1.5 * (b.scale / 2.5), speed: b.speed,
      xpScaled: true,
      attackCd: 2.2, telegraph: 0, swing: 0, hurt: 0, stagger: 0,
      spawning: 1.2, isBoss: true,
      pattern: 0, patternCd: 4.5, enraged: false,
    };
    // The boss goes through the same stuck breaker as everything else. range 0
    // keeps it pressing all the way in exactly as the old code did, and its
    // attacks stay entirely owned by _bossBrain.
    this.boss.agent = makeAgent(this.boss, 'chase');
    this.boss.agent.range = 0;
    this.enemies.push(this.boss);
    this.bossActive = true;

    this.fx.ring(pos, b.glow, 16, 1.1);
    this.fx.burst(pos.clone().setY(1), 60, b.glow, { speed: 12, up: 8, life: 1.4 });
    this.fx.addShake(0.9);
    this.audio.nova();
    this.ui.toast(`${b.name} HAS AWAKENED`, 'danger');
    this.ui.setObjective('BOSS', '');
  }

  // `record` is the roster entry this field instance represents. Its grade and
  // the owner's INT decide the numbers, so a shadow you kept and promoted is
  // still worth fielding forty levels later.
  _spawnShadow(pos, silent = false, record = null) {
    if (this.shadows.length >= this.fieldCapacity()) return null;
    const rec = record || makeShadow(this.save, { type: 'grunt', level: this.save.level });
    const c = shadowCombat(this.save, rec);
    const mesh = makeHumanoid({
      color: 0x1a2740, glow: 0x35e6ff, accent: 0x0b1220,
      weapon: 'sword', scale: 0.95 * c.scale, ghost: true, cloak: true,
      archetype: 'shadow', rank: this.gate?.rank ?? 'E',
    });
    mesh.add(makeGroundRing(0x35e6ff, 0.85 * c.scale, 0.6));
    mesh.position.copy(pos);
    this.scene.add(mesh);
    this.shadows.push({
      rec,
      mesh, pos: pos.clone(), vel: new THREE.Vector3(), yaw: 0,
      radius: c.radius, speed: c.speed,
      hp: c.hp, maxHp: c.hp,
      atk: c.atk,
      attackCd: 0, swing: 0, target: null, life: 0, kills: 0,
    });
    if (!silent) {
      this.fx.ring(pos, 0x35e6ff, 4, 0.6);
      this.fx.burst(pos.clone().setY(0.8), 22, 0x35e6ff, { speed: 6, up: 5 });
    }
    return rec;
  }

  // -------------------------------------------------------------- combat
  _damageEnemy(e, amount, opts = {}) {
    if (e.hp <= 0) return;
    const crit = Math.random() < this.derived.crit;
    const dmg = Math.max(1, Math.round(amount * (crit ? 1.85 : 1)));
    e.hp -= dmg;
    e.hurt = 0.3;
    if (opts.stagger) e.stagger = Math.max(e.stagger, opts.stagger);

    tmpV.copy(e.pos).setY(1.4 * (e.base.scale || 1));
    this.fx.damageNumber(tmpV, dmg, crit ? 'crit' : '');
    this.fx.burst(tmpV, crit ? 16 : 9, e.base.glow, { speed: 6, up: 3, life: 0.4, size: crit ? 1.3 : 1 });
    this.audio.hit(crit);
    this.fx.addShake(crit ? 0.24 : 0.12);
    this.fx.addHitStop(crit ? 0.055 : 0.03);

    if (opts.knockback) {
      tmpV2.copy(e.pos).sub(opts.from || this.player.pos).setY(0).normalize();
      e.vel.addScaledVector(tmpV2, opts.knockback / (e.isBoss ? 6 : 1));
    }

    if (e.hp <= 0) this._killEnemy(e);
  }

  _killEnemy(e) {
    e.hp = 0;
    this.killed++;
    this.player.kills++;
    this.save.totalKills++;

    this.fx.burst(e.pos.clone().setY(1), e.isBoss ? 90 : 26, e.base.glow, {
      speed: e.isBoss ? 14 : 8, up: e.isBoss ? 9 : 5, life: e.isBoss ? 1.5 : 0.8,
      size: e.isBoss ? 2 : 1,
    });
    this.fx.ring(e.pos, e.base.glow, e.isBoss ? 18 : 4, e.isBoss ? 1.2 : 0.45);
    this.fx.addShake(e.isBoss ? 1.0 : 0.2);
    this.audio.death();

    this.gainXp(e.xp);

    // Drops: a steady trickle of healing is what makes long gates survivable.
    if (e.isBoss) {
      for (let i = 0; i < 4; i++) {
        tmpV.copy(e.pos).add(new THREE.Vector3((Math.random() - 0.5) * 5, 0, (Math.random() - 0.5) * 5));
        this._spawnPickup(tmpV.clone(), i < 3 ? 'hp' : 'mp');
      }
      // A boss always leaves a weapon. It is the only guaranteed source, so
      // clearing a rank always moves your gear forward.
      this._spawnWeaponDrop(e.pos.clone());
    } else {
      const roll = Math.random();
      if (roll < WEAPON_DROP_CHANCE) this._spawnWeaponDrop(e.pos.clone());
      else if (roll < 0.26) this._spawnPickup(e.pos.clone(), 'hp');
      else if (roll < 0.34) this._spawnPickup(e.pos.clone(), 'mp');
    }

    this.scene.remove(e.mesh);
    this.scene.remove(e.bar);
    disposeObject3D(e.mesh);
    disposeObject3D(e.bar);   // hands the pooled bar slot straight back
    const idx = this.enemies.indexOf(e);
    if (idx >= 0) this.enemies.splice(idx, 1);

    if (e.isBoss) {
      this.bossActive = false;
      this.boss = null;
      this._clearGate();
      return;
    }

    // Leave a corpse that Bind can raise for a limited window.
    const corpseMesh = makeHumanoid({
      color: 0x0f1424, glow: 0x35e6ff, accent: 0x0a0d18,
      weapon: 'sword', scale: (e.base.scale || 1) * 0.95, ghost: true,
    });
    corpseMesh.position.copy(e.pos);
    corpseMesh.rotation.y = e.yaw;
    corpseMesh.rotation.x = -Math.PI / 2.4;
    corpseMesh.position.y = 0.25;
    this.scene.add(corpseMesh);
    // enemyLevel/tierWeight/attempts are what extractionChance reads; the life
    // and the chance decay share CORPSE_WINDOW so a corpse that still looks
    // raiseable still is one.
    this.corpses.push({
      mesh: corpseMesh, pos: e.pos.clone(), life: CORPSE_WINDOW,
      type: e.key, enemyLevel: e.level, tierWeight: tierWeightOf(e), attempts: 0,
    });

    if (this.killed >= this.gate.enemies && !this.bossActive) {
      this._spawnBoss();
    } else if (this.enemies.length <= 1 && this.spawned < this.gate.enemies) {
      this.spawnTimer = 0.9;
    }
  }

  _damagePlayer(amount, from) {
    const p = this.player;
    if (p.invuln > 0 || !p.alive) return;
    const dmg = Math.max(1, Math.round(amount));
    p.hp -= dmg;
    p.hurt = 0.35;
    p.invuln = 0.42;

    this.fx.damageNumber(tmpV.copy(p.pos).setY(2.2), dmg, 'player');
    this.fx.addShake(0.4);
    this.audio.hurt();
    this.flash.style.opacity = Math.min(0.42, dmg / this.derived.maxHp * 1.6);
    setTimeout(() => { this.flash.style.opacity = 0; }, 110);

    if (from) {
      tmpV2.copy(p.pos).sub(from).setY(0);
      applyKnockback(p.body, tmpV2, p.body.impulseForDistance(1.6));
    }
    if (p.hp <= 0) {
      p.hp = 0;
      p.alive = false;
      this._fail();
    }
  }

  gainXp(amount) {
    this.xpEarned += amount;
    const fromLevel = this.save.level;
    // progression.grantXp owns the level loop: it is the only place that also
    // increments save.autoStats, and the +1-to-every-stat grant silently never
    // happened while this method open-coded the loop itself.
    const r = grantXp(this.save, amount);
    const leveled = r.levelsGained;
    if (leveled > 0) {
      const gained = r.pointsGained;
      this.levelsGained += leveled;
      this.pointsGained += gained;
      // refreshDerived now credits the max-health delta itself.
      this.refreshDerived();
      this.player.hp = Math.min(this.derived.maxHp, this.player.hp + 25);
      this.player.mp = this.derived.maxMp;
      this.player.invuln = Math.max(this.player.invuln, 0.8);
      this.fx.ring(this.player.pos, 0xffc24b, 10, 0.8);
      this.fx.burst(this.player.pos.clone().setY(1), 50, 0xffc24b, { speed: 9, up: 8, life: 1.2 });
      this.audio.levelUp();
      // A single kill can cross several thresholds. Report the real span and
      // the real point count — saying "+3" after a double level is why points
      // felt untethered from levelling.
      const label = leveled > 1
        ? `LEVEL ${fromLevel} → ${this.save.level}  ·  +${gained} POINTS`
        : `LEVEL ${this.save.level}  ·  +${gained} POINTS`;
      this.ui.toast(label, 'gold');
      this.ui.flashLevelUp(this.save.level, gained);
      // Brief time dilation so a level-up registers as an event rather than a
      // toast you were too busy fighting to read.
      this.levelUpDilation = 0.5;
    }
    // Persist XP as it is earned, not only on level-up: Android kills
    // backgrounded apps and everything since the last level was being lost.
    this.onSave();
  }

  // ------------------------------------------------------------- skills
  _tryAttack() {
    const p = this.player;
    if (p.cds.attack > 0 || p.swing > 0) return;
    // Chain into the next combo step if the window is still open.
    p.comboIndex = p.comboTimer > 0 ? (p.comboIndex % 3) + 1 : 1;
    p.comboTimer = 0.95;
    p.swing = 0.34;
    p.swingHitApplied = false;
    p.cds.attack = SKILLS.attack.cd;
    this._faceNearest(7);
    this.audio.swing();
    this.ui.setCombo(p.comboIndex);
  }

  _applySwingDamage() {
    const p = this.player;
    const finisher = p.comboIndex === 3;
    // The equipped weapon's rolled multipliers ride on top of the existing
    // hardcoded sword numbers, which weapons.js's SWORD_COMBO reproduces
    // exactly — so a Common Riftedge is feel-identical to what shipped before
    // and anything better is a real upgrade rather than a cosmetic one.
    const w = this.weapon;
    const mult = SKILLS.attack.dmg * (finisher ? 1.85 : 1) * (1 + (p.comboIndex - 1) * 0.12)
      * (w?.dmgMul ?? 1);
    const range = (finisher ? 3.6 : 2.9) * (w?.reachMul ?? 1);
    const arc = (finisher ? Math.PI * 0.85 : Math.PI * 0.62) * (w?.arcMul ?? 1);
    const hits = this._coneTargets(p.pos, p.yaw, range, arc);
    hits.forEach((e) => this._damageEnemy(e, this.derived.atk * mult, {
      knockback: (finisher ? 9 : 2.5) * (w?.knockMul ?? 1),
      stagger: finisher ? 0.45 : 0,
      from: p.pos,
    }));
    if (finisher) {
      this.fx.ring(p.pos, 0x9dd8ff, 4.5, 0.35);
      this.fx.addShake(0.3);
    }
    if (hits.length === 0) this.fx.burst(tmpV.copy(p.pos).addScaledVector(this._forward(p.yaw), 2).setY(1), 4, 0x9dd8ff, { speed: 3, up: 1, life: 0.25 });
  }

  _tryDash() {
    const p = this.player;
    if (p.cds.dash > 0) return;
    const mv = this.input.sample();
    const dir = (mv.x || mv.y)
      ? tmpV.set(mv.x, 0, -mv.y).normalize()
      : this._forward(p.yaw, tmpV);
    // Authored in world units; the body solves the impulse that travels it.
    const v0 = p.body.impulseForDistance(SKILLS.dash.distance);
    p.body.addImpulse(dir.x * v0, 0, dir.z * v0);
    p.yaw = Math.atan2(dir.x, dir.z);
    p.invuln = Math.max(p.invuln, SKILLS.dash.iframes);
    p.dashTimer = 0.26;
    p.cds.dash = SKILLS.dash.cd;
    this.audio.dash();
    this.fx.burst(p.pos.clone().setY(0.7), 16, 0x9dd8ff, { speed: 4, up: 2, life: 0.4 });
  }

  _trySlash() {
    const p = this.player;
    const sk = SKILLS.slash;
    if (p.cds.slash > 0) return;
    if (this.save.level < sk.unlockLevel) return this.ui.toast(`RUIN UNLOCKS AT LEVEL ${sk.unlockLevel}`);
    if (p.mp < sk.mp) return this.ui.toast('NOT ENOUGH MANA');
    p.mp -= sk.mp;
    p.cds.slash = sk.cd;
    p.swing = 0.3;
    p.swingHitApplied = true; // this skill applies its own damage immediately
    this._faceNearest(sk.range);

    const hits = this._coneTargets(p.pos, p.yaw, sk.range, sk.arc);
    hits.forEach((e) => this._damageEnemy(e, this.derived.atk * sk.dmg * this.derived.skillMul, {
      knockback: 7, stagger: 0.35, from: p.pos,
    }));

    // Draw the cleave as a flat arc of shards sweeping outward.
    const fwd = this._forward(p.yaw);
    for (let i = 0; i < 22; i++) {
      const a = p.yaw - sk.arc / 2 + (sk.arc * i) / 21;
      tmpV2.set(Math.sin(a), 0, Math.cos(a)).multiplyScalar(sk.range * (0.35 + Math.random() * 0.65));
      tmpV2.add(p.pos).setY(0.9);
      this.fx.burst(tmpV2, 3, 0xb98bff, { speed: 5, up: 2, life: 0.45, gravity: -3 });
    }
    this.fx.addShake(0.35);
    this.audio.skill();
    void fwd;
  }

  _tryNova() {
    const p = this.player;
    const sk = SKILLS.nova;
    if (p.cds.nova > 0) return;
    if (this.save.level < sk.unlockLevel) return this.ui.toast(`NOVA UNLOCKS AT LEVEL ${sk.unlockLevel}`);
    if (p.mp < sk.mp) return this.ui.toast('NOT ENOUGH MANA');
    p.mp -= sk.mp;
    p.cds.nova = sk.cd;

    const r = sk.radius;
    // Snapshot: _damageEnemy can splice the dead out of this.enemies, and
    // mutating the array being iterated made Nova silently skip targets.
    [...this.enemies].forEach((e) => {
      const d = e.pos.distanceTo(p.pos);
      if (d < r) {
        // Falloff keeps point-blank Nova meaningfully stronger than the fringe.
        const falloff = 1 - (d / r) * 0.45;
        this._damageEnemy(e, this.derived.atk * sk.dmg * this.derived.skillMul * falloff, {
          knockback: 14, stagger: 0.7, from: p.pos,
        });
      }
    });
    // Nova also wipes incoming projectiles — a genuine panic button.
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      if (this.projectiles[i].pos.distanceTo(p.pos) < r) this._removeProjectile(i);
    }

    this.fx.ring(p.pos, 0x9dd8ff, r * 1.1, 0.55);
    this.fx.ring(p.pos, 0xffffff, r * 0.7, 0.4);
    this.fx.burst(p.pos.clone().setY(1), 70, 0x9dd8ff, { speed: 15, up: 6, life: 1, spread: 2 });
    this.fx.addShake(0.85);
    this.fx.addHitStop(0.08);
    this.audio.nova();
    p.invuln = Math.max(p.invuln, 0.3);
  }

  // Extraction is free — the cost is the corpse decaying and the three-attempt
  // limit, not mana. A failed attempt burns one of the three and leaves the
  // corpse standing, so Bind is a gamble you can press again, not a tax.
  _trySummon() {
    const p = this.player;
    const sk = SKILLS.summon;
    if (p.cds.summon > 0) return;
    if (this.save.level < sk.unlockLevel) return this.ui.toast(`BIND UNLOCKS AT LEVEL ${sk.unlockLevel}`);

    const room = this.fieldCapacity() - this.shadows.length;
    if (room <= 0) return this.ui.toast('YOUR COMPANY IS AT FULL STRENGTH');

    const inRange = this.corpses.filter((c) => (
      c.attempts < MAX_EXTRACT_ATTEMPTS && c.pos.distanceTo(p.pos) < 14
    ));
    if (inRange.length === 0) return this.ui.toast('NO FALLEN NEARBY');

    p.cds.summon = sk.cd;
    let raised = 0;
    let failed = 0;
    let rosterFull = false;

    for (const c of inRange.slice(0, room)) {
      const chance = extractionChance(this.save, {
        enemyLevel: c.enemyLevel,
        tierWeight: c.tierWeight,
        secondsSinceDeath: CORPSE_WINDOW - c.life,
        attemptIndex: c.attempts,
      });
      c.attempts++;
      if (Math.random() >= chance) {
        failed++;
        this.fx.burst(c.pos.clone().setY(0.9), 8, 0x35e6ff, { speed: 3, up: 2, life: 0.3 });
        continue;
      }
      const rec = makeShadow(this.save, { type: c.type, level: c.enemyLevel });
      const { added } = addShadow(this.save, rec);
      if (!added) { rosterFull = true; break; }
      this._spawnShadow(c.pos.clone(), false, rec);
      raised++;
      this.scene.remove(c.mesh);
      disposeObject3D(c.mesh);
      const i = this.corpses.indexOf(c);
      if (i >= 0) this.corpses.splice(i, 1);
    }

    this.audio.bind();
    this.fx.ring(p.pos, 0x35e6ff, 14, 0.7);
    if (rosterFull) this.ui.toast('YOUR ARMY WILL HOLD NO MORE', 'danger');
    else if (raised > 0) this.ui.toast(`BIND  ·  ${raised} CINDERBOUND RAISED`, 'gold');
    else this.ui.toast(`BIND FAILED  ·  ${failed} RESISTED`);
    this.onSave();
  }

  // ------------------------------------------------------------ helpers
  _forward(yaw, out = new THREE.Vector3()) {
    return out.set(Math.sin(yaw), 0, Math.cos(yaw));
  }

  _coneTargets(origin, yaw, range, arc) {
    const fwd = this._forward(yaw);
    return this.enemies.filter((e) => {
      const d = tmpV2.copy(e.pos).sub(origin).setY(0);
      const dist = d.length();
      if (dist > range + e.radius) return false;
      if (dist < 0.001) return true;
      d.divideScalar(dist);
      return d.dot(fwd) > Math.cos(arc / 2);
    });
  }

  _nearestEnemy(from, maxDist = Infinity) {
    let best = null, bestD = maxDist;
    for (const e of this.enemies) {
      const d = e.pos.distanceTo(from);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  _faceNearest(maxDist) {
    const t = this._nearestEnemy(this.player.pos, maxDist);
    if (!t) return;
    const d = tmpV.copy(t.pos).sub(this.player.pos);
    this.player.yaw = Math.atan2(d.x, d.z);
  }

  _spawnProjectile(from, target, damage, color, speed = 16) {
    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.3, 0),
      new THREE.MeshBasicMaterial({ color }),
    );
    mesh.position.copy(from);
    this.scene.add(mesh);
    const light = new THREE.PointLight(color, 2.2, 7);
    mesh.add(light);
    mesh.layers.enable(GLOW_LAYER);
    const dir = tmpV.copy(target).sub(from).setY(0).normalize().clone();
    this.projectiles.push({ mesh, pos: from.clone(), dir, speed, damage, life: 4, color });
  }

  _removeProjectile(i) {
    const p = this.projectiles[i];
    this.fx.burst(p.pos, 10, p.color, { speed: 5, up: 2, life: 0.35 });
    this.scene.remove(p.mesh);
    p.mesh.geometry.dispose();
    p.mesh.material.dispose();
    this.projectiles.splice(i, 1);
  }

  // --------------------------------------------------------------- loop
  update(rawDt) {
    const dt = Math.min(rawDt, 0.05);
    this.time += dt;
    this.world.update(dt);
    this.fx.update(dt);

    if (this.state === 'playing') {
      // Hit-stop briefly freezes simulation for weight on impacts; a level-up
      // dilates time for a moment so the moment actually registers.
      let step = this.fx.hitStop > 0 ? dt * 0.12 : dt;
      if (this.levelUpDilation > 0) {
        this.levelUpDilation = Math.max(0, this.levelUpDilation - dt);
        step *= 0.35;
      }
      this.runTime += dt;
      this._updatePlayer(step);
      this._updateEnemies(step);
      this._updateShadows(step);
      this._updateProjectiles(step);
      this._updateCorpses(step);
      this._updatePickups(step);
      this._updateSpawns(step);
      this.ui.updateHud(this);
    }

    this._updateCamera(dt);
    this.input.endFrame();
    this.glow.render(this.scene, this.camera);
    this.quality.update(rawDt);
  }

  _updatePlayer(dt) {
    const p = this.player;
    if (!p.alive) return;
    const d = this.derived;

    // cooldowns
    for (const k of Object.keys(p.cds)) if (p.cds[k] > 0) p.cds[k] = Math.max(0, p.cds[k] - dt);
    if (p.comboTimer > 0) { p.comboTimer -= dt; if (p.comboTimer <= 0) { p.comboIndex = 0; this.ui.setCombo(0); } }
    if (p.invuln > 0) p.invuln -= dt;
    if (p.hurt > 0) p.hurt -= dt;
    if (p.dashTimer > 0) p.dashTimer -= dt;

    // regen
    p.hp = Math.min(d.maxHp, p.hp + d.hpRegen * dt);
    p.mp = Math.min(d.maxMp, p.mp + d.mpRegen * dt);

    // input
    if (this.input.consume('attack') || (this.input.isHeld('attack') && p.swing <= 0 && p.cds.attack <= 0)) this._tryAttack();
    if (this.input.consume('dash')) this._tryDash();
    if (this.input.consume('slash')) this._trySlash();
    if (this.input.consume('nova')) this._tryNova();
    if (this.input.consume('summon')) this._trySummon();

    // swing timing
    if (p.swing > 0) {
      const before = p.swing;
      p.swing -= dt;
      if (!p.swingHitApplied && before > 0.17 && p.swing <= 0.17) {
        p.swingHitApplied = true;
        this._applySwingDamage();
      }
      if (p.swing <= 0) p.swing = 0;
    }

    // movement — the body owns integration, collision and ground contact
    const body = p.body;
    body.maxSpeed = d.speed;
    if (this.input.consume('jump')) body.jump();
    body.setJumpHeld(this.input.isHeld('jump'));

    const mv = this.input.sample();
    const moving = Math.abs(mv.x) > 0.01 || Math.abs(mv.y) > 0.01;
    body.move(mv.x, -mv.y, p.swing > 0 ? 0.35 : 1);

    if (moving && p.swing <= 0) {
      // Turn toward the stick, shortest way around.
      const targetYaw = Math.atan2(mv.x, -mv.y);
      let diff = targetYaw - p.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      p.yaw += diff * Math.min(1, dt * 16);
    }

    body.step(dt);
    const sp = body.groundSpeed;

    if (body.justLanded && body.landSpeed > 6) {
      // Only a real drop gets a thump; stepping off a kerb should be silent.
      this.fx.burst(p.pos.clone().setY(0.3), 10, 0x9dd8ff, { speed: 3, up: 1.4, life: 0.35 });
      this.fx.addShake(Math.min(0.35, body.landSpeed * 0.02));
      this.audio.noise({ gain: 0.1, decay: 0.14, filter: 700 });
    }

    // dash trail
    if (p.dashTimer > 0 && Math.random() < 0.7) {
      this.fx.burst(p.pos.clone().setY(0.6), 2, 0x9dd8ff, { speed: 1, up: 0.5, life: 0.3, gravity: -1 });
    }

    // present
    p.mesh.position.copy(p.pos);
    p.mesh.rotation.y = p.yaw;
    p.mesh.visible = !(p.invuln > 0 && p.dashTimer <= 0 && Math.floor(this.time * 22) % 2 === 0);
    animateRig(p.mesh, {
      moving, speed: sp, t: this.time,
      attackPhase: p.swing > 0 ? p.swing / 0.34 : 0,
      hurt: Math.max(0, p.hurt),
      airborne: !p.body.grounded,
      riseRate: p.vel.y,
      // The time-scaled dt, so hit-stop and level-up dilation slow the
      // AnimationMixer too. Without it the mixer reads wall-clock and skinned
      // characters keep moving at full speed through a freeze frame.
      dt,
    });
  }

  _updateEnemies(dt) {
    const p = this.player;
    // Crowd separation happens once for the whole field, BEFORE anyone moves.
    // Doing it per-enemy after the move loop (the old _separate) left mesh
    // positions a frame behind the separated pos.
    separate(this.enemies, 1, 900);
    for (const e of this.enemies) {
      if (e.spawning > 0) {
        e.spawning -= dt;
        const k = 1 - Math.max(0, e.spawning) / (e.isBoss ? 1.2 : 0.55);
        e.mesh.position.y = THREE.MathUtils.lerp(e.isBoss ? -6 : -3, 0, k);
        e.mesh.position.x = e.pos.x;
        e.mesh.position.z = e.pos.z;
        continue;
      }
      if (e.hurt > 0) e.hurt -= dt;
      if (e.stagger > 0) { e.stagger -= dt; }
      if (e.attackCd > 0) e.attackCd -= dt;
      if (e.telegraph > 0) {
        e.telegraph -= dt;
        if (e.telegraph <= 0) this._enemyStrike(e);
      }
      if (e.swing > 0) e.swing -= dt;

      const toPlayer = tmpV.copy(p.pos).sub(e.pos).setY(0);
      const dist = toPlayer.length();
      if (dist > 0.001) toPlayer.divideScalar(dist);

      const staggered = e.stagger > 0;
      // Steering output, in world units. The old code carried a scalar
      // `desiredSpeed` along toPlayer, which cannot express a detour.
      let moveX = 0, moveZ = 0;

      if (e.isBoss) {
        this._bossBrain(e, dt, dist, toPlayer);
        if (e.telegraph > 0 || staggered) { moveX = 0; moveZ = 0; }
        else {
          if (!e.agent) { e.agent = makeAgent(e, 'chase'); e.agent.range = 0; }
          _steerCtx.navGrid = this.world.navGrid || null;
          _steerCtx.targetPos = p.pos; _steerCtx.selfPos = e.pos;
          _steerCtx.distance = dist; _steerCtx.losBlocked = false;
          _steerCtx.aggression = 1; _steerCtx.dt = dt;
          const bsteer = steerAgent(e.agent, _steerCtx, dt);
          moveX = bsteer.moveX; moveZ = bsteer.moveZ;
        }
      } else if (!staggered && e.telegraph <= 0) {
        if (!e.agent) e.agent = makeAgent(e, e.base.ai);
        _steerCtx.navGrid = this.world.navGrid || null;
        _steerCtx.targetPos = p.pos; _steerCtx.selfPos = e.pos;
        _steerCtx.distance = dist; _steerCtx.losBlocked = false;
        _steerCtx.aggression = 1; _steerCtx.dt = dt;
        const steer = steerAgent(e.agent, _steerCtx, dt);
        moveX = steer.moveX; moveZ = steer.moveZ;
        e.vel.x += steer.impulseX; e.vel.z += steer.impulseZ;
        if (steer.wantAttack && e.attackCd <= 0) {
          e.telegraph = steer.telegraph;
          e.attackCd = e.base.attackCd + Math.random() * (steer.attackKind === 'ranged' ? 0.6 : 0.4);
          noteAttack(e.agent);
        }

        // Shadows pull aggro: if one is much closer, fight it instead.
        const near = this._nearestShadow(e.pos, 6);
        if (near && near.d < dist * 0.6) {
          const toS = tmpV2.copy(near.s.pos).sub(e.pos).setY(0);
          const dS = toS.length();
          if (dS > 0.001) toS.divideScalar(dS);
          if (dS > e.base.range) { e.vel.addScaledVector(toS, e.speed * 9 * dt); moveX = 0; moveZ = 0; }
          else if (e.attackCd <= 0) {
            near.s.hp -= e.atk * 0.6;
            e.attackCd = e.base.attackCd;
            e.swing = 0.3;
            this.fx.burst(near.s.pos.clone().setY(1), 6, 0x35e6ff, { speed: 4, up: 2, life: 0.3 });
          }
          e.yaw = Math.atan2(toS.x, toS.z);
        }
      }

      if (moveX !== 0 || moveZ !== 0) { e.vel.x += moveX * 9 * dt; e.vel.z += moveZ * 9 * dt; }
      // Deliberately still facing the PLAYER, not steer.yaw: the line below has
      // always overwritten the shadow-facing yaw above, and keeping that quirk
      // is what makes this swap behaviour-neutral outside the stuck breaker.
      if (e.telegraph <= 0 && !staggered) e.yaw = Math.atan2(toPlayer.x, toPlayer.z);

      e.vel.multiplyScalar(1 - Math.min(0.95, 7 * dt));
      e.pos.addScaledVector(e.vel, dt);
      this.world.resolve(e.pos, e.radius, e.vel);

      e.mesh.position.copy(e.pos);
      e.mesh.rotation.y = e.yaw;

      // telegraph tint: eyes flare before a strike lands
      const flare = e.telegraph > 0 ? 1 : 0;
      const rig = e.mesh.userData.rig;
      if (rig) {
        const s = flare ? 1.7 + Math.sin(this.time * 40) * 0.5 : 1;
        rig.eyeL.scale.setScalar(s);
        rig.eyeR.scale.setScalar(s);
      }

      const moving = Math.hypot(e.vel.x, e.vel.z) > 0.4;
      animateRig(e.mesh, {
        moving, speed: Math.hypot(e.vel.x, e.vel.z), t: this.time + e.pos.x,
        attackPhase: e.swing > 0 ? e.swing / 0.3 : 0,
        hurt: Math.max(0, e.hurt),
        dt,
      });

      // health bar billboard
      const h = e.isBoss ? 5.6 : 2.4 * (e.base.scale || 1);
      e.bar.position.copy(e.pos).setY(h);
      e.bar.quaternion.copy(this.camera.quaternion);
      setHealthBar(e.bar, e.hp / e.maxHp);
      e.bar.visible = e.hp < e.maxHp || e.isBoss;
    }
  }

  _enemyStrike(e) {
    const p = this.player;
    e.swing = 0.3;
    if (e.base.ai === 'ranged' && !e.isBoss) {
      this._spawnProjectile(e.pos.clone().setY(1.6), p.pos.clone().setY(1.2), e.atk, e.base.glow, 14);
      this.audio.tone({ freq: 700, type: 'triangle', gain: 0.1, decay: 0.2, sweep: 300 });
      return;
    }
    const range = (e.base.range || 2) + (e.isBoss ? 2.2 : 0.6);
    const d = tmpV.copy(p.pos).sub(e.pos).setY(0);
    if (d.length() < range) {
      const fwd = this._forward(e.yaw);
      if (d.normalize().dot(fwd) > 0.2) {
        this._damagePlayer(e.atk, e.pos);
      }
    }
    this.fx.burst(tmpV.copy(e.pos).addScaledVector(this._forward(e.yaw), 1.2).setY(1.2), 8, e.base.glow, {
      speed: 4, up: 2, life: 0.3,
    });
    this.audio.swing();
  }

  _bossBrain(b, dt, dist, toPlayer) {
    if (!b.enraged && b.hp / b.maxHp < 0.4) {
      b.enraged = true;
      b.speed *= 1.3;
      b.atk *= 1.25;
      this.ui.toast('THE BOSS IS ENRAGED', 'danger');
      this.fx.ring(b.pos, b.base.glow, 14, 0.8);
      this.audio.nova();
    }

    b.patternCd -= dt;
    if (b.telegraph > 0 || b.stagger > 0) return;

    if (b.patternCd <= 0) {
      b.pattern = Math.floor(Math.random() * 3);
      b.patternCd = (b.enraged ? 3.0 : 4.4) + Math.random() * 1.6;

      if (b.pattern === 0 && dist < 12) {
        // Slam: telegraphed radial shockwave.
        b.telegraph = 0.75;
        b._slam = true;
        this.fx.ring(b.pos, 0xff4d6d, 9, 0.75);
      } else if (b.pattern === 1) {
        // Spread shot: a fan of projectiles.
        const n = b.enraged ? 9 : 6;
        for (let i = 0; i < n; i++) {
          const a = Math.atan2(toPlayer.x, toPlayer.z) + (i - (n - 1) / 2) * 0.24;
          tmpV2.set(Math.sin(a), 0, Math.cos(a)).multiplyScalar(20).add(b.pos).setY(1.4);
          this._spawnProjectile(b.pos.clone().setY(2.4), tmpV2, b.atk * 0.6, b.base.glow, 15);
        }
        this.audio.skill();
      } else {
        // Charge.
        b.vel.addScaledVector(toPlayer, 34);
        this.fx.burst(b.pos.clone().setY(1), 20, b.base.glow, { speed: 6, up: 3 });
        this.audio.dash();
      }
    }

    if (b._slam && b.telegraph <= 0) {
      b._slam = false;
      const r = 11;
      if (this.player.pos.distanceTo(b.pos) < r) this._damagePlayer(b.atk * 1.4, b.pos);
      this.fx.ring(b.pos, 0xff4d6d, r * 1.1, 0.5);
      this.fx.burst(b.pos.clone().setY(0.6), 60, b.base.glow, { speed: 16, up: 4, life: 0.9, spread: 2 });
      this.fx.addShake(1.0);
      this.audio.nova();
    }

    if (dist < 4.5 && b.attackCd <= 0) {
      b.telegraph = 0.5;
      b.attackCd = b.enraged ? 1.5 : 2.2;
    }
  }

  _nearestShadow(from, maxDist) {
    let best = null, bestD = maxDist;
    for (const s of this.shadows) {
      const d = s.pos.distanceTo(from);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best ? { s: best, d: bestD } : null;
  }


  _updateShadows(dt) {
    for (let i = this.shadows.length - 1; i >= 0; i--) {
      const s = this.shadows[i];
      s.life += dt;
      if (s.hp <= 0) {
        this.fx.burst(s.pos.clone().setY(1), 20, 0x35e6ff, { speed: 6, up: 4, life: 0.7 });
        this.scene.remove(s.mesh);
        disposeObject3D(s.mesh);
        this.shadows.splice(i, 1);
        continue;
      }
      if (s.attackCd > 0) s.attackCd -= dt;
      if (s.swing > 0) s.swing -= dt;

      const target = this._nearestEnemy(s.pos, 26);
      let moving = false;
      if (target) {
        const d = tmpV.copy(target.pos).sub(s.pos).setY(0);
        const dist = d.length();
        if (dist > 0.001) d.divideScalar(dist);
        s.yaw = Math.atan2(d.x, d.z);
        if (dist > 2.2) { s.vel.addScaledVector(d, s.speed * 9 * dt); moving = true; }
        else if (s.attackCd <= 0) {
          s.attackCd = 0.85;
          s.swing = 0.3;
          // s.atk already carries grade, owner level and INT via shadowCombat;
          // the old extra level multiplier here double-dipped.
          const before = target.hp;
          this._damageEnemy(target, s.atk);
          if (before > 0 && target.hp <= 0) s.kills++;
        }
      } else {
        // No targets: fall in behind the player.
        const d = tmpV.copy(this.player.pos).sub(s.pos).setY(0);
        const dist = d.length();
        if (dist > 3.5) {
          d.divideScalar(dist);
          s.vel.addScaledVector(d, s.speed * 8 * dt);
          s.yaw = Math.atan2(d.x, d.z);
          moving = true;
        }
      }
      s.vel.multiplyScalar(1 - Math.min(0.95, 8 * dt));
      s.pos.addScaledVector(s.vel, dt);
      this.world.resolve(s.pos, s.radius, s.vel);
      s.mesh.position.copy(s.pos);
      s.mesh.rotation.y = s.yaw;
      animateRig(s.mesh, {
        moving, speed: Math.hypot(s.vel.x, s.vel.z), t: this.time + s.life,
        attackPhase: s.swing > 0 ? s.swing / 0.3 : 0,
        dt,
      });
    }
  }

  _updateProjectiles(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      pr.life -= dt;
      pr.pos.addScaledVector(pr.dir, pr.speed * dt);
      pr.mesh.position.copy(pr.pos);
      pr.mesh.rotation.x += dt * 9;
      pr.mesh.rotation.y += dt * 7;
      if (pr.life <= 0 || Math.hypot(pr.pos.x, pr.pos.z) > this.world.radius + 2) {
        this._removeProjectile(i);
        continue;
      }
      if (pr.pos.distanceTo(tmpV.copy(this.player.pos).setY(1.2)) < 1.1) {
        this._damagePlayer(pr.damage, pr.pos);
        this._removeProjectile(i);
      }
    }
  }

  /**
   * Roll a weapon for this gate and drop it. Uses the gate's seeded rng, so a
   * replayed seed hands out the same loot.
   */
  _spawnWeaponDrop(pos) {
    const w = rollDrop(this.rnd || Math.random, {
      rankIndex: this.gateIndex ?? 0,
      level: this.save.level,
      // Perception is the stat that already governs what you notice; letting
      // it nudge rarity gives it a second, visible job.
      luck: Math.min(0.6, (this.save.stats?.per || 0) * 0.01),
    });
    if (!w) return;
    this._spawnPickup(pos, 'weapon', w);
  }

  _spawnPickup(pos, kind = 'hp', weapon = null) {
    if (kind === 'weapon' && weapon) {
      // The drop is the weapon itself — the same mesh that ends up in the hand,
      // so what you see on the floor is literally what you pick up.
      const mesh = new THREE.Group();
      const model = buildWeaponMesh(weapon);
      model.rotation.z = 0.42;
      mesh.add(model);
      const tint = rarityColor(weapon.rarity);
      mesh.position.copy(pos).setY(1.05);
      mesh.add(new THREE.PointLight(tint, 3.0, 6));
      this.scene.add(mesh);
      this.pickups.push({
        mesh, pos: mesh.position, kind: 'weapon', weapon,
        life: 45, t: Math.random() * 6,
      });
      return;
    }
    const color = kind === 'hp' ? 0xff4d6d : 0x22d3ee;
    const mesh = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.34, 0),
      new THREE.MeshBasicMaterial({ color }),
    );
    mesh.position.copy(pos).setY(0.9);
    mesh.add(new THREE.PointLight(color, 2.4, 5));
    mesh.layers.enable(GLOW_LAYER);
    this.scene.add(mesh);
    this.pickups.push({ mesh, pos: mesh.position, kind, life: 22, t: Math.random() * 6 });
  }

  _updatePickups(dt) {
    const p = this.player;
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const it = this.pickups[i];
      it.life -= dt;
      it.t += dt;
      it.mesh.rotation.y += dt * 2.4;
      it.mesh.position.y = (it.kind === 'weapon' ? 1.05 : 0.9) + Math.sin(it.t * 3) * 0.16;

      const d = it.mesh.position.distanceTo(p.pos);
      // Magnet: drift toward the player once they're close, so you never have
      // to fight the camera to stand exactly on a drop.
      if (d < 5.5) {
        tmpV.copy(p.pos).setY(0.9).sub(it.mesh.position).normalize();
        it.mesh.position.addScaledVector(tmpV, (6.5 - d) * 2.2 * dt);
      }
      if (d < 1.5) {
        if (it.kind === 'weapon') {
          this._takeWeapon(it.weapon);
          this.fx.burst(it.mesh.position.clone(), 18, rarityColor(it.weapon.rarity), { speed: 5, up: 4, life: 0.5 });
          this.audio.tone({ freq: 520, type: 'triangle', gain: 0.14, decay: 0.35, sweep: 1500 });
          this.scene.remove(it.mesh);
          disposeObject3D(it.mesh);
          this.pickups.splice(i, 1);
          continue;
        }
        if (it.kind === 'hp') {
          const heal = Math.round(this.derived.maxHp * 0.16);
          p.hp = Math.min(this.derived.maxHp, p.hp + heal);
          this.fx.damageNumber(tmpV.copy(p.pos).setY(2.4), `+${heal}`, 'crit');
        } else {
          p.mp = Math.min(this.derived.maxMp, p.mp + Math.round(this.derived.maxMp * 0.3));
        }
        this.fx.burst(it.mesh.position.clone(), 12, it.kind === 'hp' ? 0xff4d6d : 0x22d3ee, { speed: 4, up: 3, life: 0.4 });
        this.audio.tone({ freq: 880, type: 'sine', gain: 0.12, decay: 0.18, sweep: 1300 });
        this.scene.remove(it.mesh);
        disposeObject3D(it.mesh);
        this.pickups.splice(i, 1);
        continue;
      }
      if (it.life <= 0) {
        this.scene.remove(it.mesh);
        disposeObject3D(it.mesh);
        this.pickups.splice(i, 1);
      }
    }
  }

  /**
   * Auto-equip on upgrade, stash otherwise. `score` is rollWeapon's single
   * comparable number, so this never needs to know what an affix is.
   */
  _takeWeapon(w) {
    if (!w) return;
    const held = this.weapon;
    if (!held || w.score > held.score) {
      this.equip(w);
      this.ui.toast(`${w.name.toUpperCase()}  ·  ${w.rarityName}`, 'gold');
    } else {
      this.stash.unshift(w);
      if (this.stash.length > STASH_LIMIT) this.stash.length = STASH_LIMIT;
      this._persistLoadout();
      this.ui.toast(`STASHED  ${w.name.toUpperCase()}`);
    }
  }

  _updateCorpses(dt) {
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      c.life -= dt;
      const k = Math.max(0, Math.min(1, c.life / CORPSE_WINDOW));
      c.mesh.traverse((o) => {
        if (o.isMesh && o.material.transparent) o.material.opacity = 0.62 * k;
      });
      // Corpses sink away as their raise window closes.
      c.mesh.position.y = 0.25 - (1 - k) * 1.2;
      if (c.life <= 0) {
        this.scene.remove(c.mesh);
        disposeObject3D(c.mesh);
        this.corpses.splice(i, 1);
      }
    }
  }

  _updateSpawns(dt) {
    if (this.bossActive) return;
    if (this.spawnTimer > 0) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) this._spawnWave();
    }
    if (this.enemies.length === 0 && this.spawned < this.gate.enemies && this.spawnTimer <= 0) {
      this.spawnTimer = 0.7;
    }
    if (this.enemies.length === 0 && this.spawned >= this.gate.enemies && !this.bossActive && this.killed >= this.gate.enemies) {
      this._spawnBoss();
    }
  }

  _updateCamera(dt) {
    const p = this.player;
    // Lead the camera slightly toward movement so you can see what you're running into.
    tmpV.copy(p.pos).addScaledVector(p.vel, 0.22);
    // Bias the look target away from the camera so the player sits below centre
    // and the screen is spent on the ground ahead rather than empty foreground.
    tmpV.z -= 3.4;
    this.camLook.lerp(tmpV, Math.min(1, dt * 6));
    this.camPos.copy(this.camLook).add(this.camOffset);
    this.camera.position.lerp(this.camPos, Math.min(1, dt * 7));
    this.camera.lookAt(this.camLook.x, this.camLook.y + 1.2, this.camLook.z);
    this.fx.applyShake(this.camera);
    // Fit the shadow frustum to the player rather than the whole arena: ±14
    // units at 1024 is 2.7cm/texel instead of 7.4cm.
    this.world.updateShadowCamera(this.player.pos, 14);
  }

  // --------------------------------------------------------- end states
  _clearGate() {
    this.state = 'over';
    this.audio.music(false);
    this.audio.gateClear();
    const rank = this.gate.rank;
    const t = Math.round(this.runTime);
    const prev = this.save.cleared[rank];
    const isBest = prev == null || t < prev;
    if (isBest) this.save.cleared[rank] = t;
    // The roster persists on its own now. Only per-shadow bookkeeping is
    // written back — the old `save.shadows = <count>` overwrote the whole
    // roster object with a number and wiped the army on every clear.
    this._commitShadowKills();
    const roster = rosterSummary(this.save);
    this.onSave();
    this.ui.showHud(false);
    this.ui.showResults({
      title: 'RIFT CLEARED',
      cleared: true,
      levelsGained: this.levelsGained,
      rows: [
        ['Gate', `${rank}-Rank · ${this.gate.name}`],
        ['Time', `${Math.floor(t / 60)}m ${t % 60}s${isBest ? '  (BEST)' : ''}`],
        ['Kills', String(this.player.kills)],
        ['Essence gained', `${this.xpEarned} XP`],
        ['Levels gained', this.levelsGained ? `+${this.levelsGained}` : 'none'],
        ['Stat points earned', this.pointsGained ? `+${this.pointsGained}` : 'none'],
        ['Breaker level', `${this.save.level}  (${rankOf(this.save.level)}-grade)`],
        ['Company', `${roster.count} / ${roster.capacity} bound`],
      ],
    });
  }

  // Field kills belong to the roster record, not to the throwaway field entity,
  // or every run would reset the army's service history.
  _commitShadowKills() {
    for (const s of this.shadows) {
      if (s.rec && s.kills) s.rec.kills += s.kills;
      s.kills = 0;
    }
  }

  _fail() {
    this.state = 'over';
    this.save.deaths++;
    this._commitShadowKills();
    // Death releases the weakest quarter by grade. Losing an irreplaceable
    // named shadow to one bad run is the fastest way to stop a player taking
    // risks, so releaseWeakest never touches the top of the roster.
    const lost = releaseWeakest(this.save, Math.floor(this.save.shadows.roster.length / 4));
    this.onSave();
    this.audio.music(false);
    this.audio.gameOver();
    this.fx.burst(this.player.pos.clone().setY(1), 60, 0xff4d6d, { speed: 10, up: 6, life: 1.4 });
    this.fx.addShake(1.1);
    this.ui.showHud(false);
    const t = Math.round(this.runTime);
    this.ui.showResults({
      title: 'YOU FELL',
      cleared: false,
      levelsGained: this.levelsGained,
      rows: [
        ['Gate', `${this.gate.rank}-Rank · ${this.gate.name}`],
        ['Survived', `${Math.floor(t / 60)}m ${t % 60}s`],
        ['Progress', `${this.killed} / ${this.gate.enemies} cleared`],
        ['Kills', String(this.player.kills)],
        ['Essence kept', `${this.xpEarned} XP`],
        ['Levels gained', this.levelsGained ? `+${this.levelsGained}` : 'none'],
        ['Stat points earned', this.pointsGained ? `+${this.pointsGained}` : 'none'],
        ['Soldiers lost', lost.length ? `${lost.length} released` : 'none'],
      ],
    });
  }

  pause(on) {
    if (this.state === 'over' || this.state === 'idle') return;
    this.state = on ? 'paused' : 'playing';
    this.audio.music(!on);
  }

  quit() {
    this.state = 'idle';
    this.onSave();
    this.clearEntities();
    this.world.clear();
    this.audio.music(false);
    this.ui.showHud(false);
  }
}

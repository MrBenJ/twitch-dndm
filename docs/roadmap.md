# twitch-dndm roadmap

A co-op Twitch game: the whole audience fights monsters together while the
streamer runs the story. The engine is free and open source and ships with a
free starter pack. Paid content packs come later.

Each project gets its own spec, plan and build, in order. Mark a piece `[x]`
when it is built and tested.

## Architecture in one picture

```
Core (fixed loop)    party · real-time cooldowns · encounters & rounds · fights
                     · HP & knockouts · idle removal · XP/gold/levels · adventures
                     · modifier & reaction hooks · save/restore
Plugin slots         effects · statuses · targeting · passives · stats
                     · encounter kinds · monster behavior
Content (data)       classes · abilities · items (gear + consumables) · monsters
                     · shops · events · adventures
Packs                starter (free, open source) · paid packs · each channel's own pack
Channel              enabled packs → channel pack → overrides → settings
Panel / overlay      draw from data with a fixed set of widgets; never load pack code
```

Ground rules:

- The starter pack gets no special treatment. It uses the same API as any
  other pack. If it needs an engine special case, fix the API.
- Only HP is a core stat. Packs register every other stat.
- Only official packs contain code. Streamer content is data only.
  Third-party code waits for a sandbox.
- Pack code runs only on the server. The extension and overlay render data.
- Plugins use the engine's RNG and clock. Never `Math.random` or `Date.now`.
- IDs are namespaced (`starter:sword`). Every reference is checked at load.
- When a pack is turned off, its items go dormant: kept, greyed out, and back
  when it is turned on again.
- Adventures line up the next encounter. The streamer always presses go.

## Project 1: Engine and packs (no UI)

Spec: `docs/superpowers/specs/2026-10-11-engine-and-packs-design.md`

Core engine
- [ ] Game state model (party, characters, monsters, encounter, time)
- [ ] Injected RNG and clock
- [ ] Fixed loop: encounter lifecycle, rounds, cooldowns, hold/waiting
- [ ] Fights: HP, knockouts, idle removal, end conditions
- [ ] Progression: XP, gold, levels, rewards
- [ ] Action pipeline with modifier hooks and reaction hooks (chain-depth limit)
- [ ] Typed event stream (what happened, for screens and logs)
- [ ] Game commands (spawn, heal, hold, remove, ban…) as one command API
- [ ] Save / restore of engine state

Plugin slots (registries)
- [ ] Effects
- [ ] Statuses (durations, stacking, modifier and reaction hooks)
- [ ] Targeting rules
- [ ] Passives
- [ ] Stats (name, icon, default, growth per level)
- [ ] Encounter kinds (fight is built in; others are plugins)
- [ ] Monster behavior

Content types (data, schema-checked)
- [ ] Classes (self-contained bundle)
- [ ] Abilities (cooldown + targeting + effect steps)
- [ ] Items: gear (slot, stats, passives, grants class) and consumables (use ability, uses)
- [ ] Monsters (stats, abilities, passives, behavior)
- [ ] Shops (stock, prices, timer, secret)
- [ ] Events: story beat, vote / decision, treasure / rest, trap / hazard
- [ ] Adventures (map of encounters, branches lined up for the streamer)

Packs and channels
- [ ] Pack format: manifest, code, content, art
- [ ] Pack loader with dependency, version and reference checks (fail loudly)
- [ ] Channel layering: enabled packs → channel pack → overrides → settings
- [ ] Dormant content when a pack is off or content is deleted
- [ ] Channel settings (rev 7 rules + starting items)

Starter pack (free, open source)
- [ ] Stats: attack, defense, healing power
- [ ] Effects, statuses (drowsy, knocked out, guarding), targeting, passives
- [ ] Classes: Fighter, Tank, Healer, with their weapons and abilities
- [ ] Starter monsters and default monster behavior
- [ ] Starter shop and consumables
- [ ] The four event kinds
- [ ] A sample adventure

CLI
- [ ] Play a fight or an adventure in the terminal
- [ ] Simulate many fights headless (balance checks)
- [ ] Validate a pack

## Project 2: Server and live play

Carries over most of spec rev 7 (`docs/superpowers/specs/2026-10-08-core-game-design.md` §3, §6, §7, §8, §12).

- [ ] Always-on Node server, a Room per channel, RoomManager, timers
- [ ] Postgres via Drizzle: players, channels, packs enabled, channel pack, overrides
- [ ] Command API (game and admin), shared by dock, chat and later Stream Deck
- [ ] Real time: WebSocket to dock and overlay, Extension PubSub to viewers
- [ ] Twitch auth: extension JWT, identity share, dock/overlay tokens
- [ ] Chat bot (join via chat), opt-in chat bans
- [ ] Media uploads (monster images, story beat images and video)
- [ ] Reliability: restart recovery, snapshots

## Project 3: Screens

- [ ] Streamer dock (OBS dock / Live Config): spawn, heal, hold, shops, events,
      adventure "next up" and go
- [ ] Overlay (OBS browser source): fights, story beats with video/images/text
- [ ] Twitch extension viewer panel (mobile first), fixed widget set:
      choices, vote, shop list, tap button, story card
- [ ] Simple forms to build monsters, abilities, classes and items (channel pack)

## Project 4: Adventure editor

- [ ] Visual map builder for adventures in the dock (until then, adventures are files)

## Later ideas (not scheduled)

- Chaos Mode (timed free class swapping)
- Rhythm / BPM mode (likely an encounter-kind pack)
- Programmable triggers: sounds, scripts, Stream Deck buttons
- Companion web page (QR / link)
- Paid content packs, Bits items (deterministic only), seasons / support pass
- Sharing or selling channel packs
- Third-party pack code in a sandbox
- Pick the engine license (MIT vs AGPL)

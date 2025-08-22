
# Family Ties — Multiplayer Spades (v3)

**New in this build**
- Custom gold/navy **Family Ties deck** (SVGs in `public/cards/`)
- **Spectator mode** (unlimited viewers)
- **Seat reclaim on reconnects** (held 5 minutes; token stored in `localStorage`)
- Still includes in-game chat, drag-to-play, blind nil, and persistent lobbies

## Preview / Run
```bash
npm install
npm start
# open http://localhost:3000
```
Open multiple tabs:
- Use 4 tabs to join as players (or toggle “Join as spectator” to watch).
- Disconnect a player and reload — the app should reclaim their seat and hand when they rejoin (within 5 minutes).

## Notes
- Hands are stored server-side against a **token** that your browser keeps in `localStorage`. Clearing site data will remove it.
- Card art is vector SVG for crisp scaling; swap visuals by replacing files in `public/cards/`.

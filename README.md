# RobHoot

A real-time multiplayer quiz game. The host presents questions on a shared screen while players answer from their own devices.

## Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later)

## Setup

```bash
npm install
```

## Running

```bash
npm start
```

The server starts on port **3000** by default (override with the `PORT` environment variable). On startup it prints two URLs:

- **Host** — `http://localhost:3000/host.html` (open on the main/shared screen)
- **Players** — `http://<your-local-ip>:3000/play.html` (share with players on the same network)

## How to Play

1. Open the host page — a 4-digit game PIN is displayed.
2. Players open the play page on their phones/laptops, enter the PIN and a nickname, and join the lobby.
3. The host starts the game. Questions appear on the host screen and on every player's device.
4. Players select an answer before time runs out. Faster correct answers earn more points.
5. After all questions, a final leaderboard is shown.

## Questions

Questions are loaded from `questions.csv` at startup (and reloaded each round). The CSV format is:

```
question,type,option1,option2,option3,option4,correct,time_limit
```

- **type** — `mc` (multiple choice, 4 options) or `tf` (true/false, 2 options)
- **correct** — 1-based index of the correct option
- **time_limit** — seconds per question

## License

MIT

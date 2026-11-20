# Wipewatch server (friends and clans)

The Friends and Clan pages need one shared server that everyone in your group points their app at.
It is a single file with no dependencies (Node 18 or newer).

## Run it
```
node server/server.js
```
Options (environment variables): `PORT` (default 8787), `HOST` (default 0.0.0.0), `DATA_DIR` (default `server/data`), `TRUST_PROXY=1` (set this when it sits behind a proxy or tunnel so rate limits count real client addresses).

Then in Wipewatch open **Friends**, enter the server address and pick a username.

## Make it reachable for your friends
The app only talks to **https** addresses (plain http is allowed for `localhost` only), because the account key travels with every request. Pick one:
* **Your own PC + a tunnel** - run the server here and expose it with a tunnel that gives you an https address (for example a Cloudflare Tunnel or similar). The server only works while your PC and the tunnel are running.
* **A small VPS or free app host** - run `node server/server.js` there behind an https reverse proxy (Caddy, nginx) and set `TRUST_PROXY=1`. Keep `DATA_DIR` on a persistent disk.

Anyone who can open the address can create an account, so only share it with people you want to use it. Registration is rate limited (10 accounts per hour per address).

## What it stores
Usernames, a hash of each account key (never the key itself), friend links, clan membership, and the profile snapshot each user chooses to share (skin value, a few top skins, recent activity text, recent server names, hours played, "playing now"). It does not store emails, passwords, Steam IDs, API keys or Discord webhooks.

Privacy is enforced on the server:
* **Open** profiles are searchable and viewable by anyone; **Private** profiles are hidden from search, need the exact username to send a request, and are only visible to accepted friends and clanmates.
* Every field has its own switch. A field you turn off is never sent to anyone.
* Users can delete their account from the app, which removes everything above.

## Back up / move
Everything lives in `DATA_DIR/db.json`. Copy that file to back up or move the server. Keep it private: it holds the hashed account keys.

## Tests
`node tests/social-test.js` starts a throwaway server and runs about 70 checks (accounts, friend flow, privacy, clans, limits, restart).

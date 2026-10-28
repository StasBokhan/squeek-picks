# Squeek Picks

A prediction game on Squeektoshi's wheel. Every night players call three things: how far he runs, which 3 hours he spins the most, and whether more Squeek blocks settle than the night before.

- **Points game:** free, nickname only, with a 28-night leaderboard. Stored in Supabase.
- **Nightly pot:** players buy tickets in Sepolia test ETH, up to 5 per wallet a night, each with its own picks. The top 3 tickets by that night's points split the pot 50/30/20. A bot pays out every hour.
- **My tickets:** a connected player sees every ticket from the last 2 weeks, how each night went, what they won, and refunds in one place. The leaderboard has a second tab ranking pot winners by ETH won.

The pot runs on the **Sepolia testnet only**. The contract refuses to deploy anywhere else.

## What's in the folder

| File | What it is |
|---|---|
| `index.html` | The site. |
| `config.js` | **Your settings.** Updates to `index.html` never touch this file. |
| `supabase.sql` | Database setup for the points game. Already done if you set it up before. |
| `contracts/SqueekPot.sol` | The pot contract, version 2. `SqueekPot.json` is the compiled version the page deploys. `SqueekPotV1.*` is the first version (one ticket per wallet), kept so older pots can finish. |
| `settler/` | The payout bot. |
| `.github/workflows/settle.yml` | Runs the payout bot every hour on GitHub. |
| `wallet.js` | The wallet picker (Reown AppKit). Loads only when someone connects. |
| `icon.svg` | The site icon, also shown in wallet windows. |
| `src/`, `build.mjs` | Source files, if you want to edit. `node build.mjs` rebuilds `index.html`. |
| `wallet/` | Source of `wallet.js`. `npm install && npm run build` in that folder rebuilds it. |

## Updating from the first version

1. **Copy your anon key first.** It's in your current `index.html` on GitHub, near the top of the script (`SUPABASE_ANON_KEY: "eyJ..."`).
2. Open the new `config.js` and paste it between the quotes after `SUPABASE_ANON_KEY:`. The Supabase URL is already filled in.
3. Upload the new files to your repository (see "Uploading" below). The points game keeps working with the same database.

## Setting up the pot

You need MetaMask (or Rabby) with Sepolia test ETH. Get it free from a Sepolia faucet, for example the Google Cloud Web3 faucet or the Alchemy faucet. 0.1 is plenty.

### 1. Deploy the pot

1. Open your site with `?admin` on the end: `https://YOUR-USERNAME.github.io/squeek-picks/?admin`
2. Scroll to **Pot settings** at the bottom and click **Connect wallet**. Switch to Sepolia if asked.
3. Set the ticket price (0.01 is a good start) and click **Deploy**. Confirm in your wallet.
4. Copy the address it shows. Paste it into `config.js` after `POT_ADDRESS:` and upload `config.js` again.

The wallet you deploy with is the **owner**. Only the owner can change the ticket price or the payout bot. Nobody, the owner included, can take money out of the pot.

### 2. Make a wallet for the bot

The bot needs its own wallet to send payouts. Never use your main wallet for this.

1. In MetaMask, add a new account and name it something like "Squeek bot".
2. Send it about 0.05 Sepolia ETH for gas. Each payout costs a tiny amount.
3. Copy its address. On the `?admin` page, connected with your **owner** wallet, paste it under **Payout bot wallet** and click **Set**.

### 3. Give the bot to GitHub

1. In MetaMask, open the bot account's details and reveal its private key. Copy it.
2. In your repository on GitHub, open **Settings > Secrets and variables > Actions**.
3. Under **Secrets**, click **New repository secret**. Name: `SETTLER_PRIVATE_KEY`. Value: the bot's private key.
4. Optional: switch to the **Variables** tab and add `POT_ADDRESS` with the pot address. The bot also reads it from `config.js`, so this is only a backup.

The private key only goes into that GitHub secret. Never paste it anywhere else, and never use a key from a wallet holding anything real.

### 4. Check the bot

1. Open the **Actions** tab of your repository. If GitHub asks, enable workflows.
2. Click **Pay out the nightly pot**, then **Run workflow**.
3. Open the run. The log should show the bot's address, its gas balance and "Nothing to pay out." That means it works.

From then on it runs every hour at :25 past.

## Upgrading a version 1 pot

Version 1 pots allow one ticket per wallet a night. A deployed contract can't change, so upgrading means deploying a version 2 pot next to it:

1. Open `?admin` with your owner wallet. Under **Upgrade to version 2**, check the ticket price and click **Deploy version 2**. The new pot starts with the same payout bot.
2. In `config.js`, set `POT_ADDRESS` to the new address and list the old one under `OLD_POTS`:
   ```js
   POT_ADDRESS: "0xNEW…",
   OLD_POTS: ["0xOLD…"],
   ```
3. Upload `config.js`. The page sells tickets on the new pot and still shows the old pot's last nights in My tickets, with refunds if needed. The bot pays out every pot in `config.js`, so nothing changes on GitHub.

After 3 days with no new tickets on the old pot, its nights are all done and you can remove it from `OLD_POTS`.

## The wallet picker

With a Reown project ID in `config.js`, **Connect wallet** opens a picker that lists every wallet installed in the browser, plus WalletConnect for phone wallets. Without one, the page uses the browser wallet directly, as before.

1. Sign in at [dashboard.reown.com](https://dashboard.reown.com) and create a project (type **AppKit**, framework **JavaScript**).
2. Under the project's domain settings, add `https://YOUR-USERNAME.github.io`.
3. Copy the **Project ID** and add it to `config.js`: `REOWN_PROJECT_ID: "your-id",`

The project ID is public by design, like the Supabase anon key. The domain setting is what stops other sites using it.

### Names and avatars

Wallets with an ENS name (set as primary on Ethereum mainnet) show that name and its ENS avatar everywhere a wallet appears. Every other wallet gets a dot-grid avatar made from its address, the same one every time. Names are looked up once a day per visitor and kept in their browser.

## Uploading

The easiest way is the GitHub website: in your repository, click **Add file > Upload files** and drag in the files and folders. Uploads replace files with the same name.

The workflow file sits in a hidden folder, which Windows often won't drag. Create it by hand instead:

1. Click **Add file > Create new file**.
2. Type the name `.github/workflows/settle.yml`. Typing the slashes creates the folders.
3. Paste in the contents of `settle.yml` from this folder and click **Commit changes**.

## How a night works

- **A night** runs from 12:00 UTC to 12:00 UTC, the same day the Squeekchain API uses. Picks and tickets for a night close when it starts, so players pick the next night while watching the current one.
- **Points:** distance 30 / 20 / 10 / 5 within 0.25 / 0.5 / 1 / 2 km, plus 10 for the closest guess. Peak window 20, or 5 for the window next to it. Blocks 15. Best possible night: 75.
- **Results:** distance and peak come from closed, accepted rounds. Blocks come from blocks settled on Ethereum, counted by when they settled. A market with a data gap for over a day, a tied block count, or a night he doesn't run is void.

### The pot

- Every ticket costs the same. Up to 5 tickets per wallet per night, each with its own picks, so players can spread their guesses. Each ticket ranks on its own, so one wallet can win more than one place. Players can change any of their tickets until the lock, paying only gas.
- Ranking: the night's points, then the closest distance guess, then the earlier ticket.
- Payout: 50/30/20 to the top 3. With 2 tickets, 62.5/37.5. Players tied on everything share the places they cover.
- The night is voided and everyone can refund when there's only 1 ticket, no result at all, or too many winners tied. A refund takes back all of a wallet's tickets for that night at once.
- If the bot hasn't paid a night out within 3 days of it ending, every ticket can be refunded from the page. Nobody's ticket can get stuck.
- If a payout can't be sent to a wallet, it waits in the contract and the player collects it from the page.
- The page and the bot use the same rules file (`src/logic.js`), so the expected winners shown on the page match what the bot pays.

## What protects the game

- Points picks lock in the database and stay hidden until the night starts.
- Pot tickets lock in the contract. Pot picks are public on the blockchain once bought.
- The bot can only pay a night to players who hold a ticket for it, and only between the end of the night and the 3-day refund window.
- Settings can only be changed by the owner wallet, and never the money in the pot.

## Limits worth knowing

- **The results are only as good as the device.** Squeekchain's docs say a signature proves which key signed a record, not that a hamster ran. That's fine for test ETH, and the reason this stays on Sepolia.
- **Picks in the pot are public** once a ticket is bought, so a later player can see earlier picks.
- **GitHub pauses scheduled workflows** in repositories with no activity for 60 days. Re-enable it in the Actions tab if that happens. Missed nights can still be refunded.
- **The public Sepolia RPC** can be slow or rate limited. If the bot's runs fail with network errors, get a free Sepolia RPC URL from Alchemy or Infura and add it as a secret named `SEPOLIA_RPC_URL`.
- **A deployed contract can't be changed.** To change the rules, deploy a new pot and update `POT_ADDRESS` in both places. Unpaid nights on the old pot become refundable after 3 days.
- **The Squeekchain API is in active development.** If it changes, parts of the page show as unavailable rather than wrong, and the bot waits instead of paying out.

## Welfare

The game rewards guessing, never running. Squeekchain's care policy says he's never woken or pushed to mine, and quiet nights are expected. Keep it that way: no features that tip, ping or pay anyone around his wheel time.
